import { createServer, type Server as HttpServer } from 'node:http';
import { createRequire } from 'node:module';
import { AddressInfo } from 'node:net';
import { afterEach, describe, expect, test } from 'vitest';
import { AGENT_EVENTS, WEB_EVENTS } from '../../../packages/contracts/src/index';
import { resetDaemonVersionCacheForTests } from '../src/daemon-version';
import { createInMemoryRepositories, createInMemoryServerNext } from '../src/index';
import { createServerNextUseCases } from '../src/application/usecases';
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

  test('renaming a device keeps alias records merged instead of splitting into duplicates', async () => {
    // 复现：缺 machineId/profileId 的设备每次 hello 都新建记录（deviceHello 走 ids.nextId()）。
    // 两台以相同 hostname 上线的「别名」记录，靠 deviceDisplayKey(=hostname) 在 listDevices 里合并成 1 条。
    // 改名会改变被改名记录的 hostname → deviceDisplayKey 变化 → 别名分裂 → 列表出现重复。
    const app = createInMemoryServerNext({
      now: () => 1000,
      ids: createIds([
        'user-1',
        'team-1',
        'channel-1',
        'device-1',
        'device-2',
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

    // 两台缺 machineId 的设备，以相同 hostname 上线 → 两条别名记录（不同 id）
    const helloA = await agent.emitWithAck(AGENT_EVENTS.device.hello, {
      teamId: 'team-1',
      ownerId: 'user-1',
      hostname: 'MyMac',
    });
    const helloB = await agent.emitWithAck(AGENT_EVENTS.device.hello, {
      teamId: 'team-1',
      ownerId: 'user-1',
      hostname: 'MyMac',
    });
    expect(helloA).toMatchObject({ ok: true });
    expect(helloB).toMatchObject({ ok: true });
    const deviceAId = (helloA as { device: { id: string } }).device.id;
    expect((helloB as { device: { id: string } }).device.id).not.toBe(deviceAId);

    // 改名前：别名靠相同 hostname 的 displayKey 合并，列表只 1 条
    const listBefore = await web.emitWithAck(WEB_EVENTS.device.list, { teamId: 'team-1' });
    expect(listBefore).toMatchObject({ ok: true });
    expect((listBefore as { devices: unknown[] }).devices).toHaveLength(1);

    // 改名其中一台
    const renamed = await web.emitWithAck(WEB_EVENTS.device.rename, {
      deviceId: deviceAId,
      hostname: 'NewMac',
    });
    expect(renamed).toMatchObject({ ok: true });

    // 改名后：别名不应分裂成两条重复记录
    const listAfter = await web.emitWithAck(WEB_EVENTS.device.list, { teamId: 'team-1' });
    expect(listAfter).toMatchObject({ ok: true });
    expect((listAfter as { devices: unknown[] }).devices).toHaveLength(1);
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
      agents: [{ name: 'Codex', adapterKind: 'codex-cli', category: 'agentos-hosted' }],
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

  test('deviceHello with no machineId but same hostname links new record to existing canonical via canonicalDeviceId (repo layer)', async () => {
    // canonicalDeviceId 是服务端内部字段，不出现在 DeviceDto，只能在 usecase+repo 层直接读取校验。
    // 场景：缺 machineId/profileId 的同名设备重复 hello → 第二条记录的 canonicalDeviceId 应指向第一条。
    const repositories = createInMemoryRepositories();
    const app = createServerNextUseCases({
      repositories,
      clock: { now: () => 1000 },
      ids: { nextId: createIds(['device-1', 'device-2', 'device-3']) },
    });

    // deviceHello 校验 teams.isMember(teamId, ownerId)，先建 team 并把 owner 加为成员
    await repositories.teams.create({
      id: 'team-1',
      name: 'AgentBean',
      path: 'agentbean',
      visibility: 'private',
      ownerId: 'user-1',
      currentUserRole: 'owner',
      createdAt: 1000,
    });
    await repositories.teams.addMember({ teamId: 'team-1', userId: 'user-1', role: 'owner' });

    // 第一台：无 machineId/profileId，有 hostname → 成为 canonical（canonicalDeviceId 保持 null）
    const helloA = await app.deviceHello({
      teamId: 'team-1',
      ownerId: 'user-1',
      hostname: 'MyMac',
    });
    expect(helloA).toMatchObject({ ok: true });
    const idA = (helloA as { device: { id: string } }).device.id;

    // 第二台：同样无 machineId/profileId、相同 hostname → 应建立别名关系
    const helloB = await app.deviceHello({
      teamId: 'team-1',
      ownerId: 'user-1',
      hostname: 'MyMac',
    });
    expect(helloB).toMatchObject({ ok: true });
    const idB = (helloB as { device: { id: string } }).device.id;
    expect(idB).not.toBe(idA);

    const recordA = await repositories.devices.getById(idA);
    const recordB = await repositories.devices.getById(idB);
    expect(recordA?.canonicalDeviceId).toBeNull();
    expect(recordB?.canonicalDeviceId).toBe(idA);

    await app.renameDevice({ userId: 'user-1', deviceId: idA, hostname: 'Renamed Mac' });
    const helloC = await app.deviceHello({
      teamId: 'team-1',
      ownerId: 'user-1',
      hostname: 'MyMac',
    });
    expect(helloC).toMatchObject({ ok: true });
    const idC = (helloC as { device: { id: string } }).device.id;
    const recordC = await repositories.devices.getById(idC);
    expect(recordC?.canonicalDeviceId).toBe(idA);
  });

  test('members resolve alias-hosted agents through canonicalDeviceId after canonical device rename', async () => {
    const app = createInMemoryServerNext({
      now: () => 1000,
      ids: createIds([
        'user-1',
        'team-1',
        'channel-1',
        'device-1',
        'device-2',
        'agent-1',
      ]),
    });

    await expect(
      app.registerUser({ username: 'shaw', password: 'secret', teamName: 'AgentBean' }),
    ).resolves.toMatchObject({ ok: true, user: { id: 'user-1' } });

    const helloA = await app.deviceHello({
      teamId: 'team-1',
      ownerId: 'user-1',
      hostname: 'MyMac',
    });
    const helloB = await app.deviceHello({
      teamId: 'team-1',
      ownerId: 'user-1',
      hostname: 'MyMac',
    });
    expect(helloA).toMatchObject({ ok: true });
    expect(helloB).toMatchObject({ ok: true });
    const canonicalDeviceId = (helloA as { device: { id: string } }).device.id;
    const aliasDeviceId = (helloB as { device: { id: string } }).device.id;

    await expect(
      app.renameDevice({ userId: 'user-1', deviceId: canonicalDeviceId, hostname: 'Renamed Mac' }),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      app.registerDiscoveredAgents({
        teamId: 'team-1',
        deviceId: aliasDeviceId,
        agents: [{ name: 'Codex', adapterKind: 'codex-cli', category: 'agentos-hosted' }],
      }),
    ).resolves.toMatchObject({ ok: true, agents: [{ id: 'agent-1', deviceId: aliasDeviceId }] });

    await expect(
      app.listMembers({ teamId: 'team-1', userId: 'user-1' }),
    ).resolves.toMatchObject({
      ok: true,
      agents: [{
        id: 'agent-1',
        deviceId: canonicalDeviceId,
        deviceName: 'Renamed Mac',
      }],
    });
  });
});

describe('device isLocal hint (currentDeviceId propagation)', () => {
  test('listDevices marks the device matching currentDeviceId as isLocal=true', async () => {
    const { web } = await bootDeviceIsLocalFixture('device-1');
    const listed = await web.emitWithAck(WEB_EVENTS.device.list, {});
    expect(listed).toMatchObject({ ok: true });
    const target = (listed as { devices: Array<{ id: string; isLocal?: boolean }> }).devices.find((d) => d.id === 'device-1');
    expect(target?.isLocal).toBe(true);
  });

  test('listDevices marks non-matching currentDeviceId as isLocal=false', async () => {
    const { web } = await bootDeviceIsLocalFixture('some-other-device');
    const listed = await web.emitWithAck(WEB_EVENTS.device.list, {});
    const target = (listed as { devices: Array<{ id: string; isLocal?: boolean }> }).devices.find((d) => d.id === 'device-1');
    expect(target?.isLocal).toBe(false);
  });

  test('listDevices returns isLocal=false when currentDeviceId absent (fail-closed)', async () => {
    const { web } = await bootDeviceIsLocalFixture();
    const listed = await web.emitWithAck(WEB_EVENTS.device.list, {});
    const target = (listed as { devices: Array<{ id: string; isLocal?: boolean }> }).devices.find((d) => d.id === 'device-1');
    expect(target?.isLocal).toBe(false);
  });

  test('getDevice reflects currentDeviceId in isLocal', async () => {
    const { web } = await bootDeviceIsLocalFixture('device-1');
    const got = await web.emitWithAck(WEB_EVENTS.device.get, { deviceId: 'device-1' });
    expect(got).toMatchObject({ ok: true, device: { id: 'device-1', isLocal: true } });
  });
});

describe('updateAgentConfig remote device runtime guard', () => {
  test('remote device cannot create custom agent runtime settings -> FORBIDDEN_REMOTE_DEVICE_SETTINGS', async () => {
    const { web } = await bootDeviceIsLocalFixture('some-other-device');
    const res = await web.emitWithAck(WEB_EVENTS.agent.create, {
      teamId: 'team-1',
      deviceId: 'device-1',
      name: 'my-codex',
      adapterKind: 'codex',
      command: 'codex',
    });
    expect(res).toMatchObject({ ok: false, error: 'FORBIDDEN_REMOTE_DEVICE_SETTINGS' });
  });

  test('local device can create custom agent runtime settings', async () => {
    const { web } = await bootDeviceIsLocalFixture('device-1');
    const res = await web.emitWithAck(WEB_EVENTS.agent.create, {
      teamId: 'team-1',
      deviceId: 'device-1',
      name: 'my-codex',
      adapterKind: 'codex',
      command: 'codex',
    });
    expect(res).toMatchObject({ ok: true, agent: { deviceId: 'device-1', source: 'custom' } });
  });

  test('remote device cannot edit adapterKind -> FORBIDDEN_REMOTE_DEVICE_SETTINGS', async () => {
    const { app, web } = await bootDeviceIsLocalFixture('some-other-device');
    const created = await app.createCustomAgent({
      userId: 'user-1', teamId: 'team-1', deviceId: 'device-1',
      name: 'my-codex', adapterKind: 'codex', command: 'codex',
    });
    expect(created.ok).toBe(true);
    const agentId = (created as { agent: { id: string } }).agent.id;
    const res = await web.emitWithAck(WEB_EVENTS.agent.updateConfig, { agentId, adapterKind: 'claude-code' });
    expect(res).toMatchObject({ ok: false, error: 'FORBIDDEN_REMOTE_DEVICE_SETTINGS' });
  });

  test('remote device cannot edit args/env -> FORBIDDEN_REMOTE_DEVICE_SETTINGS', async () => {
    const { app, web } = await bootDeviceIsLocalFixture('some-other-device');
    const created = await app.createCustomAgent({
      userId: 'user-1', teamId: 'team-1', deviceId: 'device-1',
      name: 'my-codex', adapterKind: 'codex', command: 'codex',
    });
    expect(created.ok).toBe(true);
    const agentId = (created as { agent: { id: string } }).agent.id;
    const argsRes = await web.emitWithAck(WEB_EVENTS.agent.updateConfig, { agentId, args: ['--model', 'gpt-5.4'] });
    expect(argsRes).toMatchObject({ ok: false, error: 'FORBIDDEN_REMOTE_DEVICE_SETTINGS' });
    const envRes = await web.emitWithAck(WEB_EVENTS.agent.updateConfig, { agentId, env: { OPENAI_API_KEY: 'secret' } });
    expect(envRes).toMatchObject({ ok: false, error: 'FORBIDDEN_REMOTE_DEVICE_SETTINGS' });
  });

  test('local device cannot retarget runtimeId to a remote device', async () => {
    const { app, web } = await bootDeviceIsLocalFixture('device-1');
    const hello = await app.deviceHello({
      teamId: 'team-1',
      ownerId: 'user-1',
      machineId: 'machine-2',
      profileId: 'default',
      hostname: 'remote-mac',
    });
    expect(hello).toMatchObject({ ok: true });
    const remoteDeviceId = (hello as { device: { id: string } }).device.id;
    const runtimes = await app.reportDeviceRuntimes({
      teamId: 'team-1',
      deviceId: remoteDeviceId,
      runtimes: [{ adapterKind: 'codex', name: 'Remote Codex', command: '/remote/codex', installed: true }],
    });
    expect(runtimes).toMatchObject({ ok: true });
    const remoteRuntimeId = (runtimes as { runtimes: Array<{ id: string }> }).runtimes[0]?.id;
    expect(remoteRuntimeId).toBeTruthy();
    const created = await app.createCustomAgent({
      userId: 'user-1', teamId: 'team-1', deviceId: 'device-1',
      name: 'my-codex', adapterKind: 'codex', command: 'codex',
    });
    expect(created.ok).toBe(true);
    const agentId = (created as { agent: { id: string } }).agent.id;
    const res = await web.emitWithAck(WEB_EVENTS.agent.updateConfig, { agentId, runtimeId: remoteRuntimeId });
    expect(res).toMatchObject({ ok: false, error: 'FORBIDDEN_REMOTE_DEVICE_SETTINGS' });
  });

  test('local device can edit adapterKind', async () => {
    const { app, web } = await bootDeviceIsLocalFixture('device-1');
    const created = await app.createCustomAgent({
      userId: 'user-1', teamId: 'team-1', deviceId: 'device-1',
      name: 'my-codex', adapterKind: 'codex', command: 'codex',
    });
    const agentId = (created as { agent: { id: string } }).agent.id;
    const res = await web.emitWithAck(WEB_EVENTS.agent.updateConfig, { agentId, adapterKind: 'claude-code' });
    expect(res).toMatchObject({ ok: true });
  });

  test('remote device can still edit non-runtime fields (name)', async () => {
    const { app, web } = await bootDeviceIsLocalFixture('some-other-device');
    const created = await app.createCustomAgent({
      userId: 'user-1', teamId: 'team-1', deviceId: 'device-1',
      name: 'my-codex', adapterKind: 'codex', command: 'codex',
    });
    const agentId = (created as { agent: { id: string } }).agent.id;
    const res = await web.emitWithAck(WEB_EVENTS.agent.updateConfig, { agentId, name: 'renamed-codex' });
    expect(res).toMatchObject({ ok: true });
  });
});

// 共享 fixture：注册用户 + 设备上线（device-1）+ 带可选 currentDeviceId 的 authenticated web socket。
// currentDeviceId 模拟 web 端 socket.ts:180 上报的本机设备 id，用于验证 isLocal 透传链路。
async function bootDeviceIsLocalFixture(currentDeviceId?: string): Promise<{ app: ReturnType<typeof createInMemoryServerNext>; web: ClientSocket; agent: ClientSocket; deviceId: string }> {
  const app = createInMemoryServerNext({
    now: () => 1000,
    ids: createIds(['user-1', 'team-1', 'channel-1', 'device-1', 'runtime-1', 'agent-1', 'message-1', 'dispatch-1', 'request-1', 'reply-1']),
  });
  const { baseUrl, ioServer, httpServer } = await startSocketServer(app);
  cleanups.push(async () => {
    await new Promise<void>((resolve) => ioServer.close(() => resolve()));
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  });
  const bootstrap = await connectClient(`${baseUrl}/web`);
  const agent = await connectClient(`${baseUrl}/agent`);
  cleanups.push(async () => { bootstrap.disconnect(); agent.disconnect(); });
  const registerAck = await bootstrap.emitWithAck(WEB_EVENTS.auth.register, {
    username: 'shaw', password: 'secret', teamName: 'AgentBean',
  });
  expect(registerAck).toMatchObject({ ok: true });
  await agent.emitWithAck(AGENT_EVENTS.device.hello, {
    teamId: 'team-1', ownerId: 'user-1', machineId: 'machine-1', profileId: 'default',
  });
  const auth: Record<string, unknown> = { token: (registerAck as { token: string }).token };
  if (currentDeviceId) auth.currentDeviceId = currentDeviceId;
  const web = await connectClient(`${baseUrl}/web`, { auth });
  cleanups.push(async () => { web.disconnect(); });
  return { app, web, agent, deviceId: 'device-1' };
}

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
