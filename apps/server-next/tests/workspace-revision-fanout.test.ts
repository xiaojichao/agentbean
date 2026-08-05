/**
 * #1084 切片2：workspace revision commit fan-out。
 *
 * 覆盖三条链路：
 * 1. resolveChannelAgentDeviceIds 系统侧解析频道 Agent 成员的 deviceId 集合（无 userId 授权）。
 * 2. commitWorkspacePublishStaging 真正新建 revision 时调 onWorkspaceRevisionCommitted；
 *    幂等 replay（staging.status==='committed'）不调。
 * 3. emitWorkspaceRevisionCommitted 对频道在线 Agent 设备 fire-and-forget 通知（.emit 不 .emitWithAck）。
 */
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { Server as IoServer } from 'socket.io';
import { Client as ClientSocket, io as createClient } from 'socket.io-client';
import type { AddressInfo } from 'node:net';
import { AGENT_EVENTS } from '../../../packages/contracts/src/index.js';
import { attachServerNextNamespaces } from '../src/transport/socket-server.js';
import { createInMemoryRepositories, createServerNextUseCases } from '../src/index.js';
import {
  createFileWorkspaceStagingContentStore,
} from '../src/application/workspace-staging-content-store.js';

function sha256(content: Buffer | string): string {
  return createHash('sha256').update(content).digest('hex');
}

function createIds(ids: string[]) {
  let i = 0;
  return () => {
    const id = ids[i];
    i += 1;
    if (!id) throw new Error(`ran out of ids at ${i}`);
    return id;
  };
}

describe('workspace revision commit fan-out (#1084)', () => {
  describe('resolveChannelAgentDeviceIds', () => {
    test('返回频道可见 Agent 成员的 deviceId（无 userId 授权，系统侧）', async () => {
      const repositories = createInMemoryRepositories();
      const app = createServerNextUseCases({
        repositories,
        clock: { now: () => 100 },
        ids: {
          nextId: createIds([
            'user-1', 'team-1', 'all-1', 'channel-1',
            'device-a', 'device-b', 'agent-a', 'agent-b',
          ]),
        },
      });
      await app.registerUser({ username: 'owner', password: 'secret', teamName: 'Team' });
      const channel = await app.createChannel({
        userId: 'user-1', teamId: 'team-1', name: 'project', visibility: 'public',
      });
      if (!channel.ok) throw new Error(channel.error);
      const channelId = channel.channel.id;

      // 注册两台设备 + 各自 Agent。
      const helloA = await app.deviceHello({
        teamId: 'team-1', ownerId: 'user-1', machineId: 'machine-a', hostname: 'device-a',
      });
      const helloB = await app.deviceHello({
        teamId: 'team-1', ownerId: 'user-1', machineId: 'machine-b', hostname: 'device-b',
      });
      if (!helloA.ok || !helloB.ok) throw new Error('device hello failed');

      const agentsA = await app.registerDiscoveredAgents({
        teamId: 'team-1', deviceId: helloA.device.id,
        agents: [{ name: 'Agent-A', adapterKind: 'hermes', category: 'agentos-hosted' }],
      });
      const agentsB = await app.registerDiscoveredAgents({
        teamId: 'team-1', deviceId: helloB.device.id,
        agents: [{ name: 'Agent-B', adapterKind: 'hermes', category: 'agentos-hosted' }],
      });
      if (!agentsA.ok || !agentsB.ok) throw new Error('agent register failed');

      // 只把 Agent-B 加入频道成员。
      const membership = await app.addChannelAgentMember({
        userId: 'user-1', teamId: 'team-1', channelId, agentId: agentsB.agents[0]!.id,
      });
      if (!membership.ok) throw new Error(membership.error);

      const deviceIds = await app.resolveChannelAgentDeviceIds({
        teamId: 'team-1', channelId,
      });
      expect(deviceIds).toEqual([helloB.device.id]);
    });

    test('channel 不存在或跨 Team 返回空数组', async () => {
      const repositories = createInMemoryRepositories();
      const app = createServerNextUseCases({
        repositories,
        clock: { now: () => 100 },
        ids: { nextId: createIds(['user-1', 'team-1', 'all-1', 'channel-1']) },
      });
      await app.registerUser({ username: 'owner', password: 'secret', teamName: 'Team' });
      const channel = await app.createChannel({
        userId: 'user-1', teamId: 'team-1', name: 'project', visibility: 'public',
      });
      if (!channel.ok) throw new Error(channel.error);
      const channelId = channel.channel.id;

      const ids = await app.resolveChannelAgentDeviceIds({
        teamId: 'team-1', channelId: 'does-not-exist',
      });
      expect(ids).toEqual([]);
      const crossTeam = await app.resolveChannelAgentDeviceIds({
        teamId: 'other-team', channelId,
      });
      expect(crossTeam).toEqual([]);
    });
  });

  describe('commitWorkspacePublishStaging fan-out 触发', () => {
    test('真正新建 revision 时调 onWorkspaceRevisionCommitted；幂等 replay 不调', async () => {
      const onWorkspaceRevisionCommitted = vi.fn();
      const repositories = createInMemoryRepositories();
      const dataDir = `/tmp/agentbean-test-ws-fanout-${Math.random().toString(36).slice(2)}`;
      const app = createServerNextUseCases({
        repositories,
        clock: { now: () => 100 },
        ids: {
          nextId: createIds([
            'user-1', 'team-1', 'all-1', 'channel-1',
            'workspace-1', 'revision-1',
            // commit 消耗 artifact + 新 revision id
            'art-1', 'rev-2',
          ]),
        },
        stagingContentStore: createFileWorkspaceStagingContentStore(dataDir),
        onWorkspaceRevisionCommitted,
      });
      await app.registerUser({ username: 'owner', password: 'secret', teamName: 'Team' });
      const channel = await app.createChannel({
        userId: 'user-1', teamId: 'team-1', name: 'project', visibility: 'public',
      });
      if (!channel.ok) throw new Error(channel.error);
      const channelId = channel.channel.id;

      // 建 baseline workspace。
      await repositories.artifacts.create({
        id: 'seed-art', teamId: 'team-1', channelId, uploaderId: 'user-1',
        filename: 'base.txt', mimeType: 'text/plain', sizeBytes: 4, pathKind: 'workspace', createdAt: 1,
      });
      const created = await app.createProjectChannelWorkspace({
        userId: 'user-1', teamId: 'team-1', channelId,
        files: [{ path: 'base.txt', artifactId: 'seed-art' }],
      });
      if (!created.ok) throw new Error(created.error);
      const baselineRevisionId = created.workspace.currentRevisionId;

      // begin + put + commit 一次 publish。
      const body = Buffer.from('fan-out-payload');
      const begin = await app.beginWorkspacePublishStaging({
        userId: 'user-1', teamId: 'team-1', channelId,
        publishId: 'pub-fanout-1',
        baselineRevisionId,
        files: [{
          path: 'docs/out.txt',
          filename: 'out.txt',
          mimeType: 'text/plain',
          expectedSizeBytes: body.length,
          expectedSha256: sha256(body),
        }],
      });
      expect(begin.ok).toBe(true);

      const put = await app.putWorkspacePublishStagingFile({
        userId: 'user-1', teamId: 'team-1', channelId,
        publishId: 'pub-fanout-1', path: 'docs/out.txt', offset: 0, content: body,
      });
      expect(put.ok).toBe(true);

      const commit1 = await app.commitWorkspacePublishStaging({
        userId: 'user-1', teamId: 'team-1', channelId, publishId: 'pub-fanout-1',
      });
      expect(commit1.ok).toBe(true);

      // 主成功路径：fan-out 被调用一次，携带新 revisionId。
      expect(onWorkspaceRevisionCommitted).toHaveBeenCalledTimes(1);
      const call = onWorkspaceRevisionCommitted.mock.calls[0]![0] as {
        teamId: string; channelId: string; workspaceId: string; revisionId: string;
      };
      expect(call).toMatchObject({ teamId: 'team-1', channelId });
      expect(call.revisionId).toBeTruthy();
      expect(call.workspaceId).toBeTruthy();

      // 幂等 replay：同一 publishId 再次 commit，staging.status==='committed' 短路，不重复 fan-out。
      const commit2 = await app.commitWorkspacePublishStaging({
        userId: 'user-1', teamId: 'team-1', channelId, publishId: 'pub-fanout-1',
      });
      expect(commit2.ok).toBe(true);
      expect(onWorkspaceRevisionCommitted).toHaveBeenCalledTimes(1);
    });
  });

  describe('emitWorkspaceRevisionCommitted socket fan-out', () => {
    const cleanups: Array<() => Promise<void>> = [];
    afterEach(async () => {
      while (cleanups.length) await cleanups.pop()!();
    });

    test('对频道在线 Agent 设备 fire-and-forget emit；离线设备不报错', async () => {
      const repositories = createInMemoryRepositories();
      const app = createServerNextUseCases({
        repositories,
        clock: { now: () => 100 },
        ids: {
          nextId: createIds([
            'user-1', 'team-1', 'all-1', 'channel-1', 'device-a', 'agent-a',
          ]),
        },
      });
      await app.registerUser({ username: 'owner', password: 'secret', teamName: 'Team' });
      const channel = await app.createChannel({
        userId: 'user-1', teamId: 'team-1', name: 'project', visibility: 'public',
      });
      if (!channel.ok) throw new Error(channel.error);
      const channelId = channel.channel.id;

      const httpServer = createServer();
      const ioServer = new IoServer(httpServer, { cors: { origin: '*' } });
      const realtime = attachServerNextNamespaces(ioServer, app, { dispatchRequestCoalesceMs: 0 });
      await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', () => resolve()));
      const address = httpServer.address() as AddressInfo;
      const baseUrl = `http://127.0.0.1:${address.port}`;
      cleanups.push(async () => {
        await new Promise<void>((resolve) => ioServer.close(() => resolve()));
        await new Promise<void>((resolve) => httpServer.close(() => resolve()));
      });

      const agentSock: ClientSocket = createClient(`${baseUrl}/agent`, {
        transports: ['websocket'], forceNew: true, reconnection: false,
      });
      cleanups.push(async () => { agentSock.disconnect(); });
      await new Promise<void>((resolve, reject) => {
        agentSock.on('connect', () => resolve());
        agentSock.on('connect_error', (e) => reject(e));
      });

      const hello = await agentSock.emitWithAck(AGENT_EVENTS.device.hello, {
        teamId: 'team-1', ownerId: 'user-1', machineId: 'machine-a', profileId: 'default',
      });
      expect(hello).toMatchObject({ ok: true, device: { id: 'device-a' } });
      const regResult = await agentSock.emitWithAck(AGENT_EVENTS.agent.registerBatch, {
        teamId: 'team-1', deviceId: 'device-a',
        agents: [{ name: 'Agent-A', adapterKind: 'hermes', category: 'agentos-hosted' }],
      });
      expect(regResult).toMatchObject({ ok: true, agents: [{ id: 'agent-a' }] });
      const membership = await app.addChannelAgentMember({
        userId: 'user-1', teamId: 'team-1', channelId, agentId: 'agent-a',
      });
      if (!membership.ok) throw new Error(membership.error);

      // 监听 revisionCommitted 事件。
      let received: unknown = null;
      agentSock.on(AGENT_EVENTS.workspace.revisionCommitted, (payload) => {
        received = payload;
      });

      // fan-out：在线设备应收到。
      await realtime.emitWorkspaceRevisionCommitted({
        teamId: 'team-1', channelId, workspaceId: 'workspace-1', revisionId: 'rev-new',
      });
      await vi.waitFor(() => {
        expect(received).toMatchObject({
          teamId: 'team-1', channelId, revisionId: 'rev-new',
        });
      });

      // 离线 / 未知频道：不抛错（at-least-once 由 daemon 重连兜底）。
      await expect(realtime.emitWorkspaceRevisionCommitted({
        teamId: 'team-1', channelId: 'no-such-channel', workspaceId: 'ws', revisionId: 'rev-x',
      })).resolves.toBeUndefined();
    });
  });
});
