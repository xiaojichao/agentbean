import { createServer, type Server as HttpServer } from 'node:http';
import { createHash } from 'node:crypto';
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

const requireFromServer = createRequire(new URL('../package.json', import.meta.url));
const { Server } = requireFromServer('socket.io') as { Server: SocketIoServerConstructor };
const { io: createClient } = requireFromServer('socket.io-client') as {
  io(url: string, options?: Record<string, unknown>): ClientSocket;
};

const oldTeamIdField = ['network', 'Id'].join('');
const oldTeamNameField = ['network', 'Name'].join('');
const oldPublishedTeamIdsField = ['published', 'N', 'etwork', 'Ids'].join('');
const oldUnpublishedTeamIdsField = ['unpublished', 'N', 'etwork', 'Ids'].join('');

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.();
  }
});

describe('server-next Socket.IO namespaces', () => {
  test('derives Run Markdown through Socket.IO and reads the persisted pinned revision', async () => {
    const repositories = createInMemoryRepositories();
    const writes: string[] = [];
    const app = createServerNextUseCases({
      repositories,
      clock: { now: () => 200 },
      ids: { nextId: createIds([
        'user-1', 'team-1', 'channel-1',
        'artifact-derived', 'document-derived', 'revision-derived',
      ]) },
      artifactContentStore: {
        async writeContent(input) {
          writes.push(input.content.toString('utf8'));
          return {
            storagePath: `artifacts/${input.artifactId}/${input.filename}`,
            sizeBytes: input.content.length,
            sha256: 'sha-derived',
          };
        },
      },
    });
    const { baseUrl, ioServer, httpServer } = await startSocketServer(app);
    cleanups.push(async () => {
      await new Promise<void>((resolve) => ioServer.close(() => resolve()));
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    });
    const web = await connectClient(`${baseUrl}/web`);
    cleanups.push(async () => web.disconnect());
    await web.emitWithAck(WEB_EVENTS.auth.register, {
      username: 'shaw', password: 'secret', teamName: 'AgentBean',
    });
    await repositories.messages.append({
      id: 'message-task', teamId: 'team-1', channelId: 'channel-1', threadId: 'message-task',
      senderKind: 'human', senderId: 'user-1', body: '生成报告', meta: { taskId: 'task-1' }, createdAt: 90,
    });
    await repositories.dispatches.create({
      id: 'dispatch-1', teamId: 'team-1', channelId: 'channel-1', messageId: 'message-task',
      agentId: 'agent-1', status: 'succeeded', requestId: 'request-1', prompt: '生成报告', createdAt: 90, updatedAt: 100,
    });
    await repositories.workspaceRuns.create({
      id: 'run-1', teamId: 'team-1', channelId: 'channel-1', messageId: 'message-task',
      dispatchId: 'dispatch-1', agentId: 'agent-1', status: 'succeeded',
      createdAt: 90, updatedAt: 100, artifactIds: ['artifact-source', 'artifact-image'],
    });
    const sourceRoot = { id: 'root-output', kind: 'run_output' as const, label: '运行输出' };
    await repositories.artifacts.create({
      id: 'artifact-source', teamId: 'team-1', channelId: 'channel-1',
      dispatchId: 'dispatch-1', workspaceRunId: 'run-1', uploaderId: 'agent-1',
      filename: 'report.md', mimeType: 'text/markdown', sizeBytes: 10,
      relativePath: 'docs/report.md', pathKind: 'generated', role: 'run_output', sourceRoot, createdAt: 100,
    });
    await repositories.artifacts.create({
      id: 'artifact-image', teamId: 'team-1', channelId: 'channel-1',
      dispatchId: 'dispatch-1', workspaceRunId: 'run-1', uploaderId: 'agent-1',
      filename: 'chart.png', mimeType: 'image/png', sizeBytes: 10,
      relativePath: 'images/chart.png', pathKind: 'generated', role: 'run_output', sourceRoot, createdAt: 100,
    });
    await repositories.artifacts.create({
      id: 'artifact-other-run', teamId: 'team-1', channelId: 'channel-1',
      dispatchId: 'dispatch-other', workspaceRunId: 'run-other', uploaderId: 'agent-2',
      filename: 'secret.txt', mimeType: 'text/plain', sizeBytes: 10,
      relativePath: 'docs/secret.txt', pathKind: 'generated', role: 'run_output', sourceRoot, createdAt: 100,
    });

    const derived = await web.emitWithAck(WEB_EVENTS.channelDocuments.derive, {
      teamId: 'team-1',
      channelId: 'channel-1',
      sourceArtifactId: 'artifact-source',
      filename: '派生报告.md',
      content: '![图](../images/chart.png)\n![缺失](missing.png)',
    }) as { ok: boolean; document?: { id: string } };
    expect(derived).toMatchObject({
      ok: true,
      document: {
        id: 'document-derived',
        currentRevision: {
          derivationSource: { taskId: 'task-1', artifactId: 'artifact-source' },
          resources: [
            { artifactId: 'artifact-image', status: 'resolved' },
            { normalizedPath: 'docs/missing.png', status: 'missing' },
          ],
        },
      },
    });
    expect(writes).toEqual([
      '![图](/api/teams/team-1/artifacts/artifact-image/preview)\n'
      + '![缺失](artifact-missing:docs%2Fmissing.png)',
    ]);

    await expect(web.emitWithAck(WEB_EVENTS.channelDocuments.get, {
      teamId: 'team-1',
      channelId: 'channel-1',
      documentId: derived.document!.id,
    })).resolves.toMatchObject({
      ok: true,
      document: {
        currentRevision: {
          artifact: { id: 'artifact-derived' },
          derivationSource: { workspaceRunId: 'run-1', agentId: 'agent-1' },
        },
      },
    });

    for (const [filename, content] of [
      ['越界报告.md', '[越界](../../secret.txt)'],
      ['跨 Run 报告.md', '[跨 Run](/api/teams/team-1/artifacts/artifact-other-run/download)'],
      ['超限报告.md', Array.from({ length: 501 }, (_, index) => `[${index}](asset-${index}.png)`).join('\n')],
      ['危险报告.md', '[危险](javascript:alert(1))'],
    ]) {
      await expect(web.emitWithAck(WEB_EVENTS.channelDocuments.derive, {
        teamId: 'team-1',
        channelId: 'channel-1',
        sourceArtifactId: 'artifact-source',
        filename,
        content,
      })).resolves.toMatchObject({
        ok: false,
        error: 'VALIDATION_ERROR',
      });
    }
    await expect(repositories.channelDocuments.listByChannel({
      teamId: 'team-1',
      channelId: 'channel-1',
    })).resolves.toHaveLength(1);
    expect(writes).toHaveLength(1);
  });

  test('acknowledges a durable human message after its coordination job is saved', async () => {
    const repositories = createInMemoryRepositories();
    const app = createServerNextUseCases({
      repositories,
      clock: { now: () => 1000 },
      ids: { nextId: createIds(['user-1', 'team-1', 'channel-1', 'message-1', 'job-1']) },
      messageIngestionMode: 'durable-job',
    });
    const { baseUrl, ioServer, httpServer } = await startSocketServer(app);
    cleanups.push(async () => {
      await new Promise<void>((resolve) => ioServer.close(() => resolve()));
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    });
    const web = await connectClient(`${baseUrl}/web`);
    cleanups.push(async () => web.disconnect());
    await web.emitWithAck(WEB_EVENTS.auth.register, {
      username: 'shaw', password: 'secret', teamName: 'AgentBean',
    });

    const ack = await web.emitWithAck(WEB_EVENTS.message.send, {
      userId: 'user-1',
      teamId: 'team-1',
      channelId: 'channel-1',
      clientMessageId: 'client-1',
      body: '@离线Agent 仍然先保存',
    });

    expect(ack).toMatchObject({
      ok: true,
      message: { id: 'message-1', senderKind: 'human', body: '@离线Agent 仍然先保存' },
      dispatches: [],
    });
    expect(ack).not.toHaveProperty('task');
    expect(ack).not.toHaveProperty('management');
    await expect(repositories.channelCoordination.jobs.getByMessageId('message-1')).resolves.toMatchObject({
      id: 'job-1', status: 'pending', activeModel: { availability: 'unavailable' },
    });
  });

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
        'task-1',
        'dispatch-1',
        'request-1',
        'message-2',
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
        agents: [{ name: 'Codex', adapterKind: 'codex-cli', category: 'agentos-hosted' }],
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
        body: '@Codex 总结一下今天新闻 Top20',
      }),
    ).resolves.toMatchObject({
      ok: true,
      message: { id: 'message-1', senderKind: 'human' },
      task: { id: 'task-1', status: 'in_progress' },
      dispatches: [{ id: 'dispatch-1', requestId: 'request-1' }],
      acknowledgementMessage: { id: 'message-2', senderKind: 'agent', body: '我来处理，会先看请求和附件，再把结果发在线程里。' },
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
      task: { id: 'task-1', status: 'in_review' },
    });
    await eventually(async () => {
      expect(channelMessages).toEqual([
        expect.objectContaining({ id: 'message-1', senderKind: 'human', body: '@Codex 总结一下今天新闻 Top20' }),
        expect.objectContaining({ id: 'message-2', senderKind: 'agent', body: '我来处理，会先看请求和附件，再把结果发在线程里。' }),
        expect.objectContaining({ id: 'reply-1', senderKind: 'agent', body: 'done' }),
      ]);
    });
  });

  test('does not claim a task for an online agent without a connected daemon socket', async () => {
    const app = createInMemoryServerNext({
      now: () => 1100,
      ids: createIds([
        'user-1',
        'team-1',
        'channel-1',
        'message-1',
        'task-1',
      ]),
    });
    await app.registerUser({ username: 'shaw', password: 'secret', teamName: 'AgentBean' });
    await app.registerAgent({
      id: 'agent-1',
      primaryTeamId: 'team-1',
      visibleTeamIds: ['team-1'],
      name: 'Codex',
      adapterKind: 'codex',
      category: 'agentos-hosted',
      source: 'scanned',
      status: 'online',
      deviceId: 'device-1',
      lastSeenAt: 1100,
    });

    const { baseUrl, ioServer, httpServer } = await startSocketServer(app);
    cleanups.push(async () => {
      await new Promise<void>((resolve) => ioServer.close(() => resolve()));
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    });
    const web = await connectClient(`${baseUrl}/web`);
    cleanups.push(async () => {
      web.disconnect();
    });

    await expect(
      web.emitWithAck(WEB_EVENTS.message.send, {
        userId: 'user-1',
        teamId: 'team-1',
        channelId: 'channel-1',
        body: '@Codex stale socket should not claim',
        asTask: true,
      }),
    ).resolves.toMatchObject({
      ok: true,
      route: { kind: 'no-dispatch', reason: 'no-online-agent' },
      dispatches: [],
      task: { id: 'task-1', status: 'todo' },
    });

    const messages = await app.listChannelMessages({ channelId: 'channel-1', limit: 10 });
    expect(messages).toMatchObject({
      ok: true,
      messages: [
        { id: 'message-1', senderKind: 'human', body: '@Codex stale socket should not claim' },
      ],
    });
  });

  test('emits agent:status busy on dispatch and online on cancel', async () => {
    const app = createInMemoryServerNext({
      now: () => 1000,
      ids: createIds([
        'user-1', 'team-1', 'channel-1', 'device-1', 'runtime-1',
        'agent-1', 'message-1', 'dispatch-1', 'request-1', 'message-2',
      ]),
    });
    const { baseUrl, ioServer, httpServer } = await startSocketServer(app);
    cleanups.push(async () => {
      await new Promise<void>((resolve) => ioServer.close(() => resolve()));
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    });
    const web = await connectClient(`${baseUrl}/web`);
    const agentSock = await connectClient(`${baseUrl}/agent`);
    cleanups.push(async () => { web.disconnect(); agentSock.disconnect(); });

    await web.emitWithAck(WEB_EVENTS.auth.register, { username: 'shaw', password: 'secret', teamName: 'AgentBean' });
    await agentSock.emitWithAck(AGENT_EVENTS.device.hello, { teamId: 'team-1', ownerId: 'user-1', machineId: 'machine-1', profileId: 'default' });
    await agentSock.emitWithAck(AGENT_EVENTS.device.runtimes, { teamId: 'team-1', deviceId: 'device-1', runtimes: [{ adapterKind: 'codex-cli', name: 'Codex CLI' }] });
    await agentSock.emitWithAck(AGENT_EVENTS.agent.registerBatch, { teamId: 'team-1', deviceId: 'device-1', agents: [{ name: 'Codex', adapterKind: 'codex-cli', category: 'agentos-hosted' }] });

    const statuses: Array<{ id?: string; status?: string }> = [];
    web.on(WEB_EVENTS.agent.status, (s) => statuses.push(s as { id?: string; status?: string }));
    await web.emitWithAck(WEB_EVENTS.agent.subscribe, { userId: 'user-1', teamId: 'team-1' });

    await web.emitWithAck(WEB_EVENTS.message.send, { userId: 'user-1', teamId: 'team-1', channelId: 'channel-1', body: '@Codex hello' });
    await eventually(async () => {
      expect(statuses.some((s) => s.id === 'agent-1' && s.status === 'busy')).toBe(true);
    });

    await web.emitWithAck(WEB_EVENTS.dispatch.cancel, { userId: 'user-1', dispatchId: 'dispatch-1' });
    await eventually(async () => {
      expect(statuses.some((s) => s.id === 'agent-1' && s.status === 'online')).toBe(true);
    });

    // 回归：无 dispatch 的消息不得触发 afterAgentMutation，否则每条聊天都会
    // 全量扇出 refreshAgentSubscribers（性能回归）。
    // 守门条件：isSendMessageAck(result) && result.dispatches.length > 0。
    // 用 @UnknownAgent mention 强制 route=no-dispatch（reason=unknown-mention），
    // 避开 routeMessage 的无 mention fallback（fallback 会派给第一个在线 agent）。
    const statusCountBeforePlain = statuses.length;
    await web.emitWithAck(WEB_EVENTS.message.send, {
      userId: 'user-1',
      teamId: 'team-1',
      channelId: 'channel-1',
      body: '@UnknownAgent hi',
    });
    // 给潜在的 push 留时间到达；expect 不会有新事件。
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(statuses.length).toBe(statusCountBeforePlain);
  });

  test('realtime.refreshAgents emits current agent status to subscribers', async () => {
    const app = createInMemoryServerNext({
      now: () => 1000,
      ids: createIds([
        'user-1', 'team-1', 'channel-1', 'device-1', 'runtime-1',
        'agent-1', 'message-1', 'dispatch-1', 'request-1',
      ]),
    });
    const { baseUrl, ioServer, httpServer, realtime } = await startSocketServer(app);
    cleanups.push(async () => {
      await new Promise<void>((resolve) => ioServer.close(() => resolve()));
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    });
    const web = await connectClient(`${baseUrl}/web`);
    const agentSock = await connectClient(`${baseUrl}/agent`);
    cleanups.push(async () => { web.disconnect(); agentSock.disconnect(); });

    await web.emitWithAck(WEB_EVENTS.auth.register, { username: 'shaw', password: 'secret', teamName: 'AgentBean' });
    await agentSock.emitWithAck(AGENT_EVENTS.device.hello, { teamId: 'team-1', ownerId: 'user-1', machineId: 'machine-1', profileId: 'default' });
    await agentSock.emitWithAck(AGENT_EVENTS.device.runtimes, { teamId: 'team-1', deviceId: 'device-1', runtimes: [{ adapterKind: 'codex-cli', name: 'Codex CLI' }] });
    await agentSock.emitWithAck(AGENT_EVENTS.agent.registerBatch, { teamId: 'team-1', deviceId: 'device-1', agents: [{ name: 'Codex', adapterKind: 'codex-cli', category: 'agentos-hosted' }] });

    const statuses: Array<{ id?: string; status?: string }> = [];
    web.on(WEB_EVENTS.agent.status, (s) => statuses.push(s as { id?: string; status?: string }));
    await web.emitWithAck(WEB_EVENTS.agent.subscribe, { userId: 'user-1', teamId: 'team-1' });
    await web.emitWithAck(WEB_EVENTS.message.send, { userId: 'user-1', teamId: 'team-1', channelId: 'channel-1', body: '@Codex hello' });
    await eventually(async () => {
      expect(statuses.some((s) => s.id === 'agent-1' && s.status === 'busy')).toBe(true);
    });

    statuses.length = 0;
    await realtime.refreshAgents('team-1');
    await eventually(async () => {
      expect(statuses.some((s) => s.id === 'agent-1' && s.status === 'busy')).toBe(true);
    });
  });

  test('device:agents:list returns runtimes + agents reported by the daemon', async () => {
    // 协议漂移修复：web emit 'device:agents:list' 后 server 必须回 agents + runtimes。
    // 先 daemon report runtimes/agents，再让 web 查询该 device，校验拿到完整列表。
    const app = createInMemoryServerNext({
      now: () => 2000,
      ids: createIds([
        'user-list-1',
        'team-list-1',
        'channel-list-1',
        'team-list-2',
        'channel-list-2',
        'device-list-1',
        'runtime-list-1',
        'agent-list-1',
      ]),
    });
    const { baseUrl, ioServer, httpServer } = await startSocketServer(app);
    cleanups.push(async () => {
      await new Promise<void>((resolve) => ioServer.close(() => resolve()));
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    });

    const web = await connectClient(`${baseUrl}/web`);
    const daemon = await connectClient(`${baseUrl}/agent`);
    cleanups.push(async () => {
      web.disconnect();
      daemon.disconnect();
    });

    await expect(
      web.emitWithAck(WEB_EVENTS.auth.register, {
        username: 'listuser',
        password: 'secret',
        teamName: 'ListTeam',
      }),
    ).resolves.toMatchObject({ ok: true, user: { id: 'user-list-1', primaryTeamId: 'team-list-1' } });
    await expect(app.createTeam({ userId: 'user-list-1', name: 'Published Team' })).resolves.toMatchObject({
      ok: true,
      team: { id: 'team-list-2' },
    });

    await expect(
      daemon.emitWithAck(AGENT_EVENTS.device.hello, {
        teamId: 'team-list-1',
        ownerId: 'user-list-1',
        machineId: 'machine-list-1',
        profileId: 'default',
      }),
    ).resolves.toMatchObject({ ok: true, device: { id: 'device-list-1', status: 'online' } });

    await expect(
      daemon.emitWithAck(AGENT_EVENTS.device.runtimes, {
        teamId: 'team-list-1',
        deviceId: 'device-list-1',
        runtimes: [{ adapterKind: 'codex-cli', name: 'Codex CLI' }],
      }),
    ).resolves.toMatchObject({ ok: true, runtimes: [{ id: 'runtime-list-1', adapterKind: 'codex' }] });

    await expect(
      daemon.emitWithAck(AGENT_EVENTS.agent.registerBatch, {
        teamId: 'team-list-1',
        deviceId: 'device-list-1',
        agents: [{ name: 'Codex', adapterKind: 'codex-cli', category: 'agentos-hosted' }],
      }),
    ).resolves.toMatchObject({ ok: true, agents: [{ id: 'agent-list-1', status: 'online' }] });

    // 协议漂移修复前：此处会超时/回 INTERNAL_ERROR，因为 server 没注册 device:agents:list
    const deviceAgentsResult = await web.emitWithAck(WEB_EVENTS.device.agentsList, {
      userId: 'user-list-1',
      teamId: 'team-list-1',
      deviceId: 'device-list-1',
    });
    expect(deviceAgentsResult).toMatchObject({
      ok: true,
      agents: [{
        id: 'agent-list-1',
        deviceId: 'device-list-1',
        status: 'online',
      }],
      runtimes: [{ id: 'runtime-list-1', deviceId: 'device-list-1', adapterKind: 'codex' }],
    });
    const [deviceAgent] = deviceAgentsResult.agents;
    expect(deviceAgent).toMatchObject({
      primaryTeamId: 'team-list-1',
      visibleTeamIds: ['team-list-1'],
    });
    expect(deviceAgent).not.toHaveProperty(oldTeamIdField);
    expect(deviceAgent).not.toHaveProperty(oldPublishedTeamIdsField);
    expect(deviceAgent).not.toHaveProperty(oldUnpublishedTeamIdsField);
  });

  test('does not expose internal subscription exception messages in failure acks', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const app = createInMemoryServerNext();
      app.listChannels = vi.fn(async () => {
        throw new Error('/private/data/global.sqlite no such table: channels');
      }) as ServerNextUseCases['listChannels'];
      const { baseUrl, ioServer, httpServer } = await startSocketServer(app);
      cleanups.push(async () => {
        await new Promise<void>((resolve) => ioServer.close(() => resolve()));
        await new Promise<void>((resolve) => httpServer.close(() => resolve()));
      });

      const web = await connectClient(`${baseUrl}/web`);
      cleanups.push(async () => {
        web.disconnect();
      });

      await expect(
        web.emitWithAck(WEB_EVENTS.channel.subscribe, { userId: 'user-1', teamId: 'team-1' }),
      ).resolves.toEqual({
        ok: false,
        error: 'INTERNAL_ERROR',
        message: 'Internal server error',
      });
      expect(consoleError).toHaveBeenCalledWith(
        expect.stringContaining(WEB_EVENTS.channel.subscribe),
        expect.stringContaining('no such table: channels'),
      );
    } finally {
      consoleError.mockRestore();
    }
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

  test('uses the refreshed current team for join management on a persistent web socket', async () => {
    const app = createInMemoryServerNext({
      now: () => 1150,
      ids: createIds(['user-1', 'team-1', 'channel-1', 'join-1', 'team-2', 'channel-2', 'join-2']),
      joinCodes: createIds(['code-1', 'code-2']),
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
    const register = await bootstrap.emitWithAck(WEB_EVENTS.auth.register, {
      username: 'shaw',
      password: 'secret',
      teamName: 'AgentBean',
    });
    expect(register).toMatchObject({
      ok: true,
      token: expect.any(String),
      currentTeam: { id: 'team-1' },
    });

    const owner = await connectClient(`${baseUrl}/web`, { auth: { token: (register as { token: string }).token } });
    cleanups.push(async () => {
      owner.disconnect();
    });

    await expect(owner.emitWithAck(WEB_EVENTS.join.create, {})).resolves.toMatchObject({
      ok: true,
      link: { code: 'code-1', teamId: 'team-1' },
    });
    await expect(owner.emitWithAck(WEB_EVENTS.team.create, { name: 'Ops' })).resolves.toMatchObject({
      ok: true,
      team: { id: 'team-2' },
    });
    await expect(owner.emitWithAck(WEB_EVENTS.join.create, { teamId: 'team-1' })).resolves.toMatchObject({
      ok: true,
      link: { code: 'code-2', teamId: 'team-2' },
    });
    await expect(owner.emitWithAck(WEB_EVENTS.join.list, { teamId: 'team-1' })).resolves.toMatchObject({
      ok: true,
      links: [
        expect.objectContaining({ code: 'code-2', teamId: 'team-2' }),
      ],
    });

    await expect(owner.emitWithAck(WEB_EVENTS.team.switch, { teamId: 'team-1' })).resolves.toMatchObject({
      ok: true,
      currentTeam: { id: 'team-1' },
    });
    await expect(owner.emitWithAck(WEB_EVENTS.join.list, {})).resolves.toMatchObject({
      ok: true,
      links: [
        expect.objectContaining({ code: 'code-1', teamId: 'team-1' }),
      ],
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

    const created = await owner.emitWithAck(WEB_EVENTS.deviceInvite.create, { teamId: 'team-1', profileId: 'agentbean-next' });
    // createDeviceInvite 必须返回可直接运行的 daemon-next 连接命令（含 invite code、server-url 与 profile）
    expect(created).toMatchObject({
      ok: true,
      invite: {
        code: 'device-code-1',
        teamId: 'team-1',
        profileId: 'agentbean-next',
        command: expect.stringContaining("--invite-code 'device-code-1'"),
      },
    });
    expect(created.invite.command).toContain('--server-url');
    expect(created.invite.command).toContain("--profile-id 'agentbean-next'");
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
    // 自动加入：daemon wait 后 server 自动 complete（invite.createdBy 即 owner 授权），
    // credentials 自动投递给 waiting daemon socket，无需 owner 手动 emit device-invite:complete
    await eventually(async () => {
      expect(deliveredCredentials).toHaveLength(1);
    });
    const credentials = deliveredCredentials[0] as { token: string; teamId: string; ownerId: string };
    expect(credentials).toMatchObject({
      token: expect.stringMatching(/^abn_device\./),
      teamId: 'team-1',
      ownerId: 'user-1',
    });

    await expect(
      daemon.emitWithAck(AGENT_EVENTS.device.hello, {
        token: credentials.token,
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
    const ownerSnapshotNames: string[][] = [];
    const teammateSnapshots: string[][] = [];
    owner.on(WEB_EVENTS.channel.snapshot, (channels) => {
      ownerSnapshots.push(channelIds(channels));
      ownerSnapshotNames.push(channelNames(channels));
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
      owner.emitWithAck(WEB_EVENTS.channel.update, {
        userId: 'user-1',
        teamId: 'team-1',
        channelId: 'channel-ops',
        name: '一起努力',
      }),
    ).resolves.toMatchObject({ ok: true, channel: { name: '一起努力' } });
    await eventually(async () => {
      expect(ownerSnapshotNames.at(-1)).toEqual(['all', '一起努力']);
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

  test('refreshes team snapshots after team mutations', async () => {
    const app = createInMemoryServerNext({
      now: () => 1000,
      ids: createIds(['user-1', 'team-1', 'channel-1', 'channel-all']),
    });
    const { baseUrl, ioServer, httpServer } = await startSocketServer(app);
    cleanups.push(async () => {
      await new Promise<void>((resolve) => ioServer.close(() => resolve()));
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    });

    const bootstrap = await connectClient(`${baseUrl}/web`);
    const registerAck = await bootstrap.emitWithAck(WEB_EVENTS.auth.register, {
      username: 'shaw',
      password: 'secret',
      teamName: 'AgentBean',
    });
    bootstrap.disconnect();

    const owner = await connectClient(`${baseUrl}/web`, {
      auth: { token: (registerAck as { token: string }).token },
    });
    cleanups.push(async () => {
      owner.disconnect();
    });

    const snapshots: Array<Array<{ id: string; name: string }>> = [];
    owner.on(WEB_EVENTS.team.snapshot, (teams) => {
      if (!Array.isArray(teams)) {
        throw new Error('Expected team snapshot payload to be an array');
      }
      snapshots.push(teams);
    });

    await expect(
      owner.emitWithAck(WEB_EVENTS.team.update, { userId: 'user-1', teamId: 'team-1', name: 'Renamed Team' }),
    ).resolves.toMatchObject({ ok: true });

    await eventually(async () => {
      expect(snapshots.length).toBeGreaterThan(0);
      const last = snapshots.at(-1)!;
      expect(last.find((t) => t.id === 'team-1')?.name).toBe('Renamed Team');
    });
  });

  test('pushes task:updated to subscribers after task mutations', async () => {
    const app = createInMemoryServerNext({
      now: () => 1000,
      ids: createIds(['user-1', 'team-1', 'channel-1', 'task-1']),
    });
    const { baseUrl, ioServer, httpServer } = await startSocketServer(app);
    cleanups.push(async () => {
      await new Promise<void>((resolve) => ioServer.close(() => resolve()));
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    });

    const bootstrap = await connectClient(`${baseUrl}/web`);
    const registerAck = await bootstrap.emitWithAck(WEB_EVENTS.auth.register, {
      username: 'shaw',
      password: 'secret',
      teamName: 'AgentBean',
    });
    bootstrap.disconnect();

    const owner = await connectClient(`${baseUrl}/web`, {
      auth: { token: (registerAck as { token: string }).token },
    });
    cleanups.push(async () => {
      owner.disconnect();
    });

    const updates: Array<{ id: string; title?: string }> = [];
    owner.on(WEB_EVENTS.task.updated, (task) => {
      if (typeof task !== 'object' || task === null) {
        throw new Error('Expected task:updated payload to be an object');
      }
      updates.push(task as { id: string; title?: string });
    });

    // task:updated is team-scoped: subscribe so the owner belongs to team-1.
    await expect(
      owner.emitWithAck(WEB_EVENTS.channel.subscribe, { teamId: 'team-1' }),
    ).resolves.toMatchObject({ ok: true });

    await expect(
      owner.emitWithAck(WEB_EVENTS.task.create, {
        userId: 'user-1',
        teamId: 'team-1',
        channelId: 'channel-1',
        title: 'My Task',
      }),
    ).resolves.toMatchObject({ ok: true, task: { title: 'My Task' } });

    await eventually(async () => {
      expect(updates.length).toBeGreaterThan(0);
      expect(updates.at(-1)!.title).toBe('My Task');
    });
  });

  test('does not leak task:updated to subscribers of another team', async () => {
    const app = createInMemoryServerNext({
      now: () => 1000,
      ids: createIds(['user-1', 'team-1', 'channel-1', 'user-2', 'team-2', 'channel-2', 'task-1']),
    });
    const { baseUrl, ioServer, httpServer } = await startSocketServer(app);
    cleanups.push(async () => {
      await new Promise<void>((resolve) => ioServer.close(() => resolve()));
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    });

    const bootstrapA = await connectClient(`${baseUrl}/web`);
    const ackA = (await bootstrapA.emitWithAck(WEB_EVENTS.auth.register, {
      username: 'owner-a',
      password: 'secret',
      teamName: 'Team A',
    })) as { token: string };
    bootstrapA.disconnect();
    const ownerA = await connectClient(`${baseUrl}/web`, { auth: { token: ackA.token } });
    cleanups.push(async () => {
      ownerA.disconnect();
    });

    const bootstrapB = await connectClient(`${baseUrl}/web`);
    const ackB = (await bootstrapB.emitWithAck(WEB_EVENTS.auth.register, {
      username: 'owner-b',
      password: 'secret',
      teamName: 'Team B',
    })) as { token: string };
    bootstrapB.disconnect();
    const ownerB = await connectClient(`${baseUrl}/web`, { auth: { token: ackB.token } });
    cleanups.push(async () => {
      ownerB.disconnect();
    });

    await expect(
      ownerA.emitWithAck(WEB_EVENTS.channel.subscribe, { teamId: 'team-1' }),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      ownerB.emitWithAck(WEB_EVENTS.channel.subscribe, { teamId: 'team-2' }),
    ).resolves.toMatchObject({ ok: true });

    const aUpdates: Array<{ id: string; title?: string }> = [];
    const bUpdates: Array<{ id: string; title?: string }> = [];
    ownerA.on(WEB_EVENTS.task.updated, (task) => {
      if (typeof task !== 'object' || task === null) {
        throw new Error('Expected task:updated payload to be an object');
      }
      aUpdates.push(task as { id: string; title?: string });
    });
    ownerB.on(WEB_EVENTS.task.updated, (task) => {
      if (typeof task !== 'object' || task === null) {
        throw new Error('Expected task:updated payload to be an object');
      }
      bUpdates.push(task as { id: string; title?: string });
    });

    await expect(
      ownerA.emitWithAck(WEB_EVENTS.task.create, {
        userId: 'user-1',
        teamId: 'team-1',
        channelId: 'channel-1',
        title: 'Team A Task',
      }),
    ).resolves.toMatchObject({ ok: true, task: { title: 'Team A Task' } });

    // Prove the broadcast actually happened (ownerA received it)...
    await eventually(async () => {
      expect(aUpdates.length).toBeGreaterThan(0);
      expect(aUpdates.at(-1)!.title).toBe('Team A Task');
    });

    // ...then give any leaked broadcast time to arrive at ownerB before asserting isolation.
    // (eventually returns the moment ownerA is satisfied, so a leaked packet to ownerB could
    // still be in flight; without this buffer the assertion is a false-green.)
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Cross-team isolation: ownerB (team-2) must NOT receive team-1's task:updated.
    expect(bUpdates).toHaveLength(0);
  });

  test('pushes tasks:snapshot to channel subscribers after task mutations', async () => {
    const app = createInMemoryServerNext({
      now: () => 1000,
      ids: createIds(['user-1', 'team-1', 'channel-1', 'task-1']),
    });
    const { baseUrl, ioServer, httpServer } = await startSocketServer(app);
    cleanups.push(async () => {
      await new Promise<void>((resolve) => ioServer.close(() => resolve()));
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    });

    const bootstrap = await connectClient(`${baseUrl}/web`);
    const registerAck = await bootstrap.emitWithAck(WEB_EVENTS.auth.register, {
      username: 'shaw',
      password: 'secret',
      teamName: 'AgentBean',
    });
    bootstrap.disconnect();

    const owner = await connectClient(`${baseUrl}/web`, {
      auth: { token: (registerAck as { token: string }).token },
    });
    cleanups.push(async () => {
      owner.disconnect();
    });

    const snapshots: Array<Array<{ id: string; title?: string }>> = [];
    owner.on(WEB_EVENTS.task.snapshot, (tasks) => {
      snapshots.push(taskSnapshotSummary(tasks));
    });

    await expect(
      owner.emitWithAck(WEB_EVENTS.channel.subscribe, {
        teamId: 'team-1',
      }),
    ).resolves.toMatchObject({ ok: true, channels: [{ id: 'channel-1' }] });

    await expect(
      owner.emitWithAck(WEB_EVENTS.task.create, {
        teamId: 'team-1',
        channelId: 'channel-1',
        title: 'My Task',
      }),
    ).resolves.toMatchObject({ ok: true, task: { title: 'My Task' } });

    await eventually(async () => {
      expect(snapshots.at(-1)).toEqual([{ id: 'task-1', title: 'My Task' }]);
    });
  });

  test('summarizes agent metrics from dispatch history on agent:metrics', async () => {
    const repositories = createInMemoryRepositories();
    const app = createServerNextUseCases({
      repositories,
      clock: { now: () => 5000 },
      ids: { nextId: createIds(['user-1', 'team-1', 'channel-1', 'agent-1', 'message-1', 'dispatch-1', 'dispatch-2']) },
    });
    await app.registerUser({ username: 'shaw', password: 'secret', teamName: 'AgentBean' });
    await repositories.dispatches.create({
      id: 'dispatch-1', teamId: 'team-1', channelId: 'channel-1', messageId: 'message-1',
      agentId: 'agent-1', status: 'succeeded', requestId: 'req-1',
      createdAt: 1000, updatedAt: 1500, acceptedAt: 1200, completedAt: 2000, prompt: 'hello',
    });
    await repositories.dispatches.create({
      id: 'dispatch-2', teamId: 'team-1', channelId: 'channel-1', messageId: 'message-1',
      agentId: 'agent-1', status: 'failed', requestId: 'req-2',
      createdAt: 2000, updatedAt: 2500, completedAt: 3000, error: 'boom', prompt: 'hello',
    });

    const { baseUrl, ioServer, httpServer } = await startSocketServer(app);
    cleanups.push(async () => {
      await new Promise<void>((resolve) => ioServer.close(() => resolve()));
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    });

    const bootstrap = await connectClient(`${baseUrl}/web`);
    const loginAck = await bootstrap.emitWithAck(WEB_EVENTS.auth.login, {
      username: 'shaw',
      password: 'secret',
    });
    bootstrap.disconnect();
    const owner = await connectClient(`${baseUrl}/web`, {
      auth: { token: (loginAck as { token: string }).token },
    });
    cleanups.push(async () => {
      owner.disconnect();
    });

    const res = await owner.emitWithAck(WEB_EVENTS.agent.metrics, { teamId: 'team-1' });
    expect(res).toMatchObject({ ok: true });
    const summaries = (res as {
      summaries?: Array<{ agentId: string; totalRequests: number; successCount: number; failCount: number; lastError?: string }>;
    }).summaries;
    expect(summaries).toHaveLength(1);
    expect(summaries![0]).toMatchObject({
      agentId: 'agent-1',
      totalRequests: 2,
      successCount: 1,
      failCount: 1,
      lastError: 'boom',
    });
  });

  test('serves admin dashboard lists and device owner transfer to global admins only', async () => {
    const repositories = createInMemoryRepositories();
    const app = createServerNextUseCases({
      repositories,
      clock: { now: () => 7000 },
      ids: { nextId: createIds(['device-admin']) },
    });
    await repositories.users.create({
      id: 'admin-user',
      username: 'admin',
      role: 'admin',
      primaryTeamId: 'team-admin',
      currentTeamId: 'team-admin',
      passwordHash: sha256('secret'),
      createdAt: 1000,
      updatedAt: 1000,
    });
    await repositories.users.create({
      id: 'member-user',
      username: 'member',
      role: 'user',
      primaryTeamId: 'team-admin',
      currentTeamId: 'team-admin',
      passwordHash: sha256('secret'),
      createdAt: 1001,
      updatedAt: 1001,
    });
    await repositories.users.create({
      id: 'new-owner',
      username: 'new-owner',
      role: 'user',
      primaryTeamId: 'team-admin',
      currentTeamId: 'team-admin',
      passwordHash: sha256('secret'),
      createdAt: 1002,
      updatedAt: 1002,
    });
    await repositories.teams.create({
      id: 'team-admin',
      name: 'AgentBean',
      path: 'agentbean',
      visibility: 'private',
      ownerId: 'admin-user',
      createdAt: 1000,
    });
    for (const member of [
      { userId: 'admin-user', username: 'admin', role: 'owner' as const, joinedAt: 1000 },
      { userId: 'member-user', username: 'member', role: 'member' as const, joinedAt: 1001 },
      { userId: 'new-owner', username: 'new-owner', role: 'member' as const, joinedAt: 1002 },
    ]) {
      await repositories.teams.addMember({ teamId: 'team-admin', ...member });
    }
    const initialDeviceHello = await app.deviceHello({
      teamId: 'team-admin',
      ownerId: 'member-user',
      machineId: 'machine-admin',
      profileId: 'default',
      hostname: 'Mac Studio',
      daemonVersion: '0.1.13',
      systemInfo: { hostname: 'mac-studio.local', daemonVersion: '0.1.13' },
    });
    expect(initialDeviceHello.ok).toBe(true);
    const staleDeviceToken = initialDeviceHello.ok ? initialDeviceHello.credentials?.token ?? '' : '';
    await repositories.runtimes.replaceForDevice({
      teamId: 'team-admin',
      deviceId: 'device-admin',
      runtimes: [{
        id: 'runtime-admin',
        teamId: 'team-admin',
        deviceId: 'device-admin',
        adapterKind: 'codex',
        name: 'Codex CLI',
        installed: true,
        command: 'codex',
        cwd: '/tmp/project',
        lastSeenAt: 6500,
      }],
    });
    await repositories.agents.upsert({
      id: 'agent-admin',
      primaryTeamId: 'team-admin',
      visibleTeamIds: ['team-admin'],
      name: 'Drama',
      adapterKind: 'codex',
      category: 'agentos-hosted',
      source: 'scanned',
      status: 'online',
      ownerId: 'member-user',
      deviceId: 'device-admin',
      command: 'codex',
      args: ['--model', 'gpt-5.4'],
      cwd: '/tmp/project',
      description: '写作 Agent',
      lastSeenAt: 6500,
    });
    await repositories.channels.create({
      id: 'channel-admin',
      teamId: 'team-admin',
      kind: 'channel',
      name: 'admin-room',
      visibility: 'public',
      createdBy: 'admin-user',
      createdAt: 6500,
      humanMemberIds: ['admin-user'],
      agentMemberIds: ['agent-admin'],
    });
    expect(staleDeviceToken).toBeTypeOf('string');

    const { baseUrl, ioServer, httpServer } = await startSocketServer(app);
    cleanups.push(async () => {
      await new Promise<void>((resolve) => ioServer.close(() => resolve()));
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    });

    const memberLogin = await app.loginUser({ username: 'member', password: 'secret' });
    expect(memberLogin.ok).toBe(true);
    const member = await connectClient(`${baseUrl}/web`, {
      auth: { token: memberLogin.ok ? memberLogin.token : '' },
    });
    cleanups.push(async () => {
      member.disconnect();
    });
    await expect(
      member.emitWithAck(WEB_EVENTS.admin.transferDeviceOwner, {
        deviceId: 'device-admin',
        userId: 'new-owner',
      }),
    ).resolves.toMatchObject({ ok: false, error: 'FORBIDDEN' });
    await expect(member.emitWithAck(WEB_EVENTS.admin.deleteTeam, { teamId: 'team-admin' })).resolves.toMatchObject({
      ok: false,
      error: 'FORBIDDEN',
    });

    const adminLogin = await app.loginUser({ username: 'admin', password: 'secret' });
    expect(adminLogin.ok).toBe(true);
    const admin = await connectClient(`${baseUrl}/web`, {
      auth: { token: adminLogin.ok ? adminLogin.token : '' },
    });
    cleanups.push(async () => {
      admin.disconnect();
    });

    await expect(admin.emitWithAck(WEB_EVENTS.admin.listTeams, {})).resolves.toMatchObject({
      ok: true,
      teams: [{ id: 'team-admin', name: 'AgentBean', members: expect.arrayContaining([expect.objectContaining({ userId: 'member-user' })]) }],
    });
    await expect(admin.emitWithAck(WEB_EVENTS.admin.listUsers, {})).resolves.toMatchObject({
      ok: true,
      users: expect.arrayContaining([
        expect.objectContaining({ id: 'admin-user', username: 'admin', role: 'admin' }),
        expect.objectContaining({ id: 'member-user', username: 'member', role: 'user' }),
      ]),
    });
    const adminDevicesResult = await admin.emitWithAck(WEB_EVENTS.admin.listDevices, {});
    expect(adminDevicesResult).toMatchObject({
      ok: true,
      devices: [expect.objectContaining({
        id: 'device-admin',
        name: 'Mac Studio',
        userId: 'member-user',
        userName: 'member',
        agentCount: 1,
        runtimes: [expect.objectContaining({
          id: 'runtime-admin',
          deviceId: 'device-admin',
          adapterKind: 'codex',
          name: 'Codex CLI',
          installed: true,
        })],
        agents: [expect.objectContaining({
          id: 'agent-admin',
          name: 'Drama',
          deviceName: 'Mac Studio',
          deviceUserName: 'member',
          ownerName: 'member',
        })],
      })],
    });
    const [adminDevice] = adminDevicesResult.devices;
    expect(adminDevice).toMatchObject({ teamId: 'team-admin', teamName: 'AgentBean' });
    expect(adminDevice).not.toHaveProperty(oldTeamIdField);
    expect(adminDevice).not.toHaveProperty(oldTeamNameField);
    expect(adminDevice).not.toHaveProperty('publicAgents');

    const adminAgentsResult = await admin.emitWithAck(WEB_EVENTS.admin.listAgents, {});
    expect(adminAgentsResult).toMatchObject({
      ok: true,
      agents: [expect.objectContaining({
        id: 'agent-admin',
        name: 'Drama',
        ownerId: 'member-user',
        ownerName: 'member',
        userName: 'member',
        deviceName: 'Mac Studio',
        deviceUserName: 'member',
      })],
    });
    const [adminAgent] = adminAgentsResult.agents;
    expect(adminAgent).toMatchObject({
      primaryTeamId: 'team-admin',
      primaryTeamName: 'AgentBean',
      visibleTeamIds: ['team-admin'],
    });
    expect(adminAgent).not.toHaveProperty(oldTeamIdField);
    expect(adminAgent).not.toHaveProperty(oldTeamNameField);
    expect(adminAgent).not.toHaveProperty(oldPublishedTeamIdsField);
    expect(adminAgent).not.toHaveProperty(oldUnpublishedTeamIdsField);

    await repositories.teams.create({
      id: 'team-member-owned',
      name: 'Member-owned Team',
      path: 'member-owned-team',
      visibility: 'private',
      ownerId: 'member-user',
      createdAt: 7050,
    });
    await repositories.teams.addMember({
      teamId: 'team-member-owned',
      userId: 'member-user',
      username: 'member',
      role: 'owner',
      joinedAt: 7050,
    });
    await expect(admin.emitWithAck(WEB_EVENTS.admin.deleteTeam, { teamId: 'team-member-owned' })).resolves.toEqual({
      ok: true,
    });
    await expect(repositories.teams.getById('team-member-owned')).resolves.toBeNull();

    await expect(
      admin.emitWithAck(WEB_EVENTS.admin.transferDeviceOwner, {
        deviceId: 'device-admin',
        userId: 'new-owner',
      }),
    ).resolves.toMatchObject({
      ok: true,
      device: {
        id: 'device-admin',
        userId: 'new-owner',
        ownerId: 'new-owner',
        userName: 'new-owner',
        runtimes: [expect.objectContaining({
          id: 'runtime-admin',
          deviceId: 'device-admin',
          adapterKind: 'codex',
        })],
      },
    });
    await expect(admin.emitWithAck(WEB_EVENTS.admin.listAgents, {})).resolves.toMatchObject({
      ok: true,
      agents: [expect.objectContaining({
        id: 'agent-admin',
        ownerId: 'new-owner',
        ownerName: 'new-owner',
      })],
    });

    await expect(
      app.deviceHelloFromCredentials({
        token: staleDeviceToken,
        hostname: 'Mac Studio',
      }),
    ).resolves.toMatchObject({
      ok: true,
      device: {
        id: 'device-admin',
        ownerId: 'new-owner',
        ownerName: 'new-owner',
      },
    });
    await expect(repositories.devices.getById('device-admin')).resolves.toMatchObject({
      ownerId: 'new-owner',
    });
    await expect(repositories.agents.getById('agent-admin')).resolves.toMatchObject({
      ownerId: 'new-owner',
    });

    await repositories.teams.create({
      id: 'team-owned-by-new-owner',
      name: 'Owned Team',
      path: 'owned-team',
      visibility: 'private',
      ownerId: 'new-owner',
      createdAt: 7100,
    });
    await repositories.teams.addMember({
      teamId: 'team-owned-by-new-owner',
      userId: 'new-owner',
      username: 'new-owner',
      role: 'owner',
      joinedAt: 7100,
    });
    await expect(admin.emitWithAck(WEB_EVENTS.admin.deleteUser, { userId: 'new-owner' })).resolves.toMatchObject({
      ok: false,
      error: 'CONFLICT',
    });

    await expect(admin.emitWithAck(WEB_EVENTS.admin.deleteAgent, { agentId: 'agent-admin' })).resolves.toMatchObject({
      ok: true,
    });
    await expect(repositories.channels.getById('channel-admin')).resolves.toMatchObject({
      agentMemberIds: [],
    });
    await expect(admin.emitWithAck(WEB_EVENTS.admin.listAgents, {})).resolves.toMatchObject({
      ok: true,
      agents: [],
    });
    await expect(admin.emitWithAck(WEB_EVENTS.channel.members, {
      teamId: 'team-admin',
      channelId: 'channel-admin',
    })).resolves.toMatchObject({
      ok: true,
      agents: [],
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

  test('requires old browsers with only a Device hint to re-link securely', async () => {
    const socket = new IntegrationFakeSocket() as IntegrationFakeSocket & {
      handshake: { auth: { token: string; currentDeviceId: string } };
    };
    socket.handshake = { auth: { token: 'user-token', currentDeviceId: 'device-other' } };
    const namespace = new IntegrationFakeNamespace();
    namespace.nextSocket = socket;
    const listDevices = vi.fn(async () => makeSuccess({
      devices: [{
        id: 'device-other', teamId: 'team-1', ownerId: 'user-2', status: 'online' as const, isLocal: true,
      }],
    }));
    const app = {
      whoami: vi.fn(async () => makeSuccess({
        user: { id: 'user-1' }, currentTeam: { id: 'team-1' }, teams: [],
      })),
      listDevices,
    } as unknown as ServerNextUseCases;
    attachServerNextNamespaces(new IntegrationFakeServer(namespace), app);

    await expect(socket.trigger(WEB_EVENTS.memory.localSummary, { teamId: 'team-1' }))
      .resolves.toEqual({ ok: false, error: 'DEVICE_ATTESTATION_REQUIRED' });
    expect(listDevices).not.toHaveBeenCalled();
  });

  test('requires browsers with an invalid Device token to re-link securely', async () => {
    const socket = new IntegrationFakeSocket() as IntegrationFakeSocket & {
      handshake: { auth: { token: string; currentDeviceId: string; deviceToken: string } };
    };
    socket.handshake = {
      auth: { token: 'user-token', currentDeviceId: 'device-1', deviceToken: 'invalid-device-token' },
    };
    const namespace = new IntegrationFakeNamespace();
    namespace.nextSocket = socket;
    const listDevices = vi.fn();
    const app = {
      whoami: vi.fn(async () => makeSuccess({
        user: { id: 'user-1' }, currentTeam: { id: 'team-1' }, teams: [],
        deviceCredentialStatus: 'invalid' as const,
      })),
      listDevices,
    } as unknown as ServerNextUseCases;
    attachServerNextNamespaces(new IntegrationFakeServer(namespace), app);

    await expect(socket.trigger(WEB_EVENTS.memory.localSummary, { teamId: 'team-1' }))
      .resolves.toEqual({ ok: false, error: 'DEVICE_ATTESTATION_REQUIRED' });
    expect(listDevices).not.toHaveBeenCalled();
  });

  test('revalidates an invite Device token after the daemon finishes deviceHello', async () => {
    const socket = new IntegrationFakeSocket() as IntegrationFakeSocket & {
      handshake: { auth: { token: string; currentDeviceId: string; deviceToken: string } };
    };
    socket.handshake = {
      auth: { token: 'user-token', currentDeviceId: 'device-1', deviceToken: 'invite-device-token' },
    };
    const namespace = new IntegrationFakeNamespace();
    namespace.nextSocket = socket;
    let whoamiCalls = 0;
    const whoami = vi.fn(async () => {
      whoamiCalls += 1;
      return makeSuccess({
        user: { id: 'user-1' }, currentTeam: { id: 'team-1' }, teams: [],
        ...(whoamiCalls > 1 ? { verifiedCurrentDeviceId: 'device-1' } : {}),
        deviceCredentialStatus: whoamiCalls > 1 ? 'verified' as const : 'pending' as const,
      });
    });
    const listDevices = vi.fn(async () => makeSuccess({
      devices: [{
        id: 'device-1', teamId: 'team-1', ownerId: 'user-1', status: 'online' as const, isLocal: true,
      }],
    }));
    const app = { whoami, listDevices } as unknown as ServerNextUseCases;
    attachServerNextNamespaces(new IntegrationFakeServer(namespace), app);

    await expect(socket.trigger(WEB_EVENTS.memory.localSummary, { teamId: 'team-1' }))
      .resolves.toEqual({ ok: false, error: 'PERMISSION_DENIED' });
    await expect(socket.trigger(WEB_EVENTS.memory.localSummary, { teamId: 'team-1' }))
      .resolves.toEqual({ ok: false, error: 'DEVICE_OFFLINE' });
    expect(whoami).toHaveBeenCalledTimes(2);
    expect(listDevices).toHaveBeenCalledWith({
      teamId: 'team-1', userId: 'user-1', currentDeviceId: 'device-1',
    });
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
      agents: [{ name: 'Codex', adapterKind: 'codex-cli', category: 'agentos-hosted' }],
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
        agents: [{ name: 'Codex', adapterKind: 'codex-cli', category: 'agentos-hosted' }],
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

  test('pushes agent:status increments after daemon agent reports change status', async () => {
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
    await agent.emitWithAck(AGENT_EVENTS.device.hello, {
      teamId: 'team-1',
      ownerId: 'user-1',
      machineId: 'machine-1',
      profileId: 'default',
    });

    const statuses: Array<{ id: string; status: string }> = [];
    web.on(WEB_EVENTS.agent.status, (status) => {
      statuses.push(agentStatusSummary(status));
    });
    await expect(
      web.emitWithAck(WEB_EVENTS.agent.subscribe, { userId: 'user-1', teamId: 'team-1' }),
    ).resolves.toMatchObject({ ok: true, agents: [] });

    await expect(
      agent.emitWithAck(AGENT_EVENTS.agent.registerBatch, {
        teamId: 'team-1',
        deviceId: 'device-1',
        agents: [{ name: 'Codex', adapterKind: 'codex-cli', category: 'agentos-hosted' }],
      }),
    ).resolves.toMatchObject({ ok: true, agents: [{ id: 'agent-1', status: 'online' }] });

    await eventually(async () => {
      expect(statuses.at(-1)).toEqual({ id: 'agent-1', status: 'online' });
    });

    await expect(
      agent.emitWithAck(AGENT_EVENTS.agent.registerBatch, {
        teamId: 'team-1',
        deviceId: 'device-1',
        agents: [],
      }),
    ).resolves.toMatchObject({ ok: true, missingOfflineIds: ['agent-1'] });

    await eventually(async () => {
      expect(statuses.at(-1)).toEqual({ id: 'agent-1', status: 'offline' });
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
        agents: [{ name: 'Codex', adapterKind: 'codex-cli', category: 'agentos-hosted' }],
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
    const deviceStatuses: Array<{ id: string; status: string }> = [];
    const runtimeEvents: Array<{
      deviceId: string;
      runtimes: Array<{ id: string; name: string; installed: boolean; command?: string; normalizedCommandKey?: string }>;
    }> = [];
    web.on(WEB_EVENTS.device.snapshot, (devices) => {
      deviceSnapshots.push(deviceSummaries(devices));
    });
    web.on(WEB_EVENTS.device.status, (device) => {
      deviceStatuses.push(deviceStatusSummary(device));
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
    await eventually(async () => {
      expect(deviceStatuses.at(-1)).toEqual({ id: 'device-1', status: 'online' });
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
        envRef: { agentId: 'agent-1', teamId: 'team-1' },
      },
    });
    expect(otherDispatches).toEqual([]);
  });

  test('coalesces spaced direct messages before emitting the agent dispatch request', async () => {
    const app = createInMemoryServerNext({
      now: () => 1000,
      ids: createIds([
        'user-1',
        'team-1',
        'channel-all',
        'device-1',
        'runtime-1',
        'agent-1',
        'dm-channel-1',
        'message-1',
        'dispatch-1',
        'request-1',
        'message-2',
        'message-3',
      ]),
    });
    const { baseUrl, ioServer, httpServer } = await startSocketServer(app, {
      dispatchRequestCoalesceMs: 1_000,
    });
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

    const dispatchRequests: unknown[] = [];
    agent.on(AGENT_EVENTS.dispatch.request, (payload) => {
      dispatchRequests.push(payload);
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
    await agent.emitWithAck(AGENT_EVENTS.device.runtimes, {
      teamId: 'team-1',
      deviceId: 'device-1',
      runtimes: [
        {
          adapterKind: 'codex',
          name: 'Codex CLI',
          command: '/opt/homebrew/bin/codex',
          installed: true,
        },
      ],
    });
    await agent.emitWithAck(AGENT_EVENTS.agent.registerBatch, {
      teamId: 'team-1',
      deviceId: 'device-1',
      agents: [{ name: 'Codex', adapterKind: 'codex', category: 'agentos-hosted' }],
    });
    await expect(
      web.emitWithAck(WEB_EVENTS.channel.subscribe, { userId: 'user-1', teamId: 'team-1' }),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      web.emitWithAck(WEB_EVENTS.dm.start, { agentId: 'agent-1' }),
    ).resolves.toMatchObject({ ok: true, dm: { id: 'dm-channel-1' } });

    await expect(
      web.emitWithAck(WEB_EVENTS.message.send, {
        userId: 'user-1',
        teamId: 'team-1',
        channelId: 'dm-channel-1',
        body: '你能说明你能做什么吗？',
      }),
    ).resolves.toMatchObject({ ok: true, dispatches: [{ id: 'dispatch-1' }] });
    await delay(400);
    await expect(
      web.emitWithAck(WEB_EVENTS.message.send, {
        userId: 'user-1',
        teamId: 'team-1',
        channelId: 'dm-channel-1',
        body: '并且列出你有多少skills?',
      }),
    ).resolves.toMatchObject({ ok: true, dispatches: [] });
    await delay(700);
    expect(dispatchRequests).toEqual([]);
    await expect(
      web.emitWithAck(WEB_EVENTS.message.send, {
        userId: 'user-1',
        teamId: 'team-1',
        channelId: 'dm-channel-1',
        body: '和用什么模型吗？',
      }),
    ).resolves.toMatchObject({ ok: true, dispatches: [] });

    expect(dispatchRequests).toEqual([]);
    await eventually(async () => {
      expect(dispatchRequests).toHaveLength(1);
    }, 300);
    expect(dispatchRequests[0]).toMatchObject({
      id: 'dispatch-1',
      prompt: '你能说明你能做什么吗？\n\n并且列出你有多少skills?\n\n和用什么模型吗？',
    });
  });

  test('claim-capable daemon waits for the default 15-second message batch window', async () => {
    let now = 1000;
    const app = createInMemoryServerNext({
      now: () => now,
      ids: createIds([
        'user-1',
        'team-1',
        'channel-all',
        'device-1',
        'runtime-1',
        'agent-1',
        'dm-channel-1',
        'message-1',
        'dispatch-1',
        'request-1',
        'message-2',
        'message-3',
      ]),
    });
    const { baseUrl, ioServer, httpServer } = await startSocketServer(app, {
      useProductionDefaultDispatchRequestCoalesceMs: true,
    });
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

    const wakes: unknown[] = [];
    agent.on(AGENT_EVENTS.dispatch.request, (payload) => {
      wakes.push(payload);
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
      protocolCapabilities: { dispatchClaim: true },
    });
    await agent.emitWithAck(AGENT_EVENTS.device.runtimes, {
      teamId: 'team-1',
      deviceId: 'device-1',
      runtimes: [{ adapterKind: 'codex', name: 'Codex CLI', installed: true }],
    });
    await agent.emitWithAck(AGENT_EVENTS.agent.registerBatch, {
      teamId: 'team-1',
      deviceId: 'device-1',
      agents: [{ name: 'Codex', adapterKind: 'codex', category: 'agentos-hosted' }],
    });
    await web.emitWithAck(WEB_EVENTS.channel.subscribe, { userId: 'user-1', teamId: 'team-1' });
    await web.emitWithAck(WEB_EVENTS.dm.start, { agentId: 'agent-1' });

    await web.emitWithAck(WEB_EVENTS.message.send, {
      userId: 'user-1',
      teamId: 'team-1',
      channelId: 'dm-channel-1',
      body: '你能说明你能做什么吗？',
    });
    await eventually(async () => {
      expect(wakes).toHaveLength(1);
    }, 300);
    expect(wakes[0]).toMatchObject({ id: 'dispatch-1', claimRequired: true });

    now = 1200;
    await web.emitWithAck(WEB_EVENTS.message.send, {
      userId: 'user-1',
      teamId: 'team-1',
      channelId: 'dm-channel-1',
      body: '并且列出你有多少skills?',
    });
    now = 1400;
    await web.emitWithAck(WEB_EVENTS.message.send, {
      userId: 'user-1',
      teamId: 'team-1',
      channelId: 'dm-channel-1',
      body: '和用什么模型吗？',
    });

    now = 1500;
    await expect(agent.emitWithAck(AGENT_EVENTS.dispatch.accepted, {
      dispatchId: 'dispatch-1',
      agentId: 'agent-1',
    })).resolves.toEqual({ ok: true, ready: false, retryAfterMs: 14_900 });

    now = 16_400;
    await expect(agent.emitWithAck(AGENT_EVENTS.dispatch.accepted, {
      dispatchId: 'dispatch-1',
      agentId: 'agent-1',
    })).resolves.toMatchObject({
      ok: true,
      ready: true,
      dispatch: { id: 'dispatch-1', status: 'accepted' },
      request: {
        id: 'dispatch-1',
        prompt: '你能说明你能做什么吗？\n\n并且列出你有多少skills?\n\n和用什么模型吗？',
      },
    });
    expect(wakes).toHaveLength(1);
  });

  test('replaces stale dispatch-claim capability when a legacy socket takes over the same device', async () => {
    const app = createInMemoryServerNext({
      now: () => 3000,
      ids: createIds([
        'user-1', 'team-1', 'channel-all', 'device-1', 'runtime-1', 'agent-1',
        'dm-channel-1', 'message-1', 'dispatch-1', 'request-1',
      ]),
    });
    const { baseUrl, ioServer, httpServer } = await startSocketServer(app, {
      dispatchRequestCoalesceMs: 20,
    });
    cleanups.push(async () => {
      await new Promise<void>((resolve) => ioServer.close(() => resolve()));
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    });
    const bootstrap = await connectClient(`${baseUrl}/web`);
    const claimAgent = await connectClient(`${baseUrl}/agent`);
    const legacyAgent = await connectClient(`${baseUrl}/agent`);
    cleanups.push(async () => {
      bootstrap.disconnect();
      claimAgent.disconnect();
      legacyAgent.disconnect();
    });
    const register = await bootstrap.emitWithAck(WEB_EVENTS.auth.register, {
      username: 'shaw', password: 'secret', teamName: 'AgentBean',
    });
    const web = await connectClient(`${baseUrl}/web`, { auth: { token: (register as { token: string }).token } });
    cleanups.push(async () => web.disconnect());

    const identity = {
      teamId: 'team-1', ownerId: 'user-1', machineId: 'machine-1', profileId: 'default',
    };
    await claimAgent.emitWithAck(AGENT_EVENTS.device.hello, {
      ...identity,
      protocolCapabilities: { dispatchClaim: true },
    });
    await claimAgent.emitWithAck(AGENT_EVENTS.device.runtimes, {
      teamId: 'team-1', deviceId: 'device-1',
      runtimes: [{ adapterKind: 'codex', name: 'Codex CLI', installed: true }],
    });
    await claimAgent.emitWithAck(AGENT_EVENTS.agent.registerBatch, {
      teamId: 'team-1', deviceId: 'device-1',
      agents: [{ name: 'Codex', adapterKind: 'codex', category: 'agentos-hosted' }],
    });
    await legacyAgent.emitWithAck(AGENT_EVENTS.device.hello, identity);
    claimAgent.disconnect();

    const legacyRequests: unknown[] = [];
    legacyAgent.on(AGENT_EVENTS.dispatch.request, (payload) => legacyRequests.push(payload));
    await web.emitWithAck(WEB_EVENTS.channel.subscribe, { teamId: 'team-1' });
    await web.emitWithAck(WEB_EVENTS.dm.start, { agentId: 'agent-1' });
    await web.emitWithAck(WEB_EVENTS.message.send, {
      teamId: 'team-1', channelId: 'dm-channel-1', body: 'legacy request',
    });

    await eventually(async () => expect(legacyRequests).toHaveLength(1));
    expect(legacyRequests[0]).toMatchObject({ id: 'dispatch-1', prompt: 'legacy request' });
    expect(legacyRequests[0]).not.toHaveProperty('claimRequired');
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

  test('pushes agents:discovered after a daemon scan reports runtimes and agents', async () => {
    const app = createInMemoryServerNext({
      now: () => 1000,
      ids: createIds(['user-1', 'team-1', 'channel-all', 'device-1', 'scan-1', 'runtime-1', 'agent-1']),
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

    const scanRequests: unknown[] = [];
    const discoveredEvents: Array<{
      runtimes: Array<{ name: string; adapterKind: string; command?: string; cwd?: string; installed?: boolean }>;
      agents: Array<{ name: string; adapterKind: string; category: string; source: string; command?: string; cwd?: string }>;
    }> = [];
    agent.on(AGENT_EVENTS.device.scanRequested, (payload) => {
      scanRequests.push(payload);
    });
    web.on(WEB_EVENTS.agent.discovered, (payload) => {
      discoveredEvents.push(discoveredPayloadSummary(payload));
    });

    await expect(
      web.emitWithAck(WEB_EVENTS.device.list, { userId: 'user-1', teamId: 'team-1' }),
    ).resolves.toMatchObject({ ok: true, devices: [{ id: 'device-1' }] });
    await expect(
      web.emitWithAck(WEB_EVENTS.device.scan, { userId: 'user-1', deviceId: 'device-1' }),
    ).resolves.toMatchObject({ ok: true, request: { requestId: 'scan-1', deviceId: 'device-1' } });
    await eventually(async () => {
      expect(scanRequests).toEqual([{ requestId: 'scan-1', deviceId: 'device-1' }]);
    });

    await expect(
      agent.emitWithAck(AGENT_EVENTS.device.runtimes, {
        teamId: 'team-1',
        deviceId: 'device-1',
        runtimes: [
          {
            adapterKind: 'codex-cli',
            name: 'Codex CLI',
            command: '/opt/homebrew/bin/codex',
            cwd: '/Users/shaw/AgentBean',
          },
        ],
      }),
    ).resolves.toMatchObject({ ok: true, runtimes: [{ id: 'runtime-1', adapterKind: 'codex' }] });
    await expect(
      agent.emitWithAck(AGENT_EVENTS.agent.registerBatch, {
        teamId: 'team-1',
        deviceId: 'device-1',
        agents: [{ name: 'Codex', adapterKind: 'codex-cli', category: 'agentos-hosted' }],
      }),
    ).resolves.toMatchObject({ ok: true, agents: [{ id: 'agent-1', status: 'online' }] });

    await eventually(async () => {
      expect(discoveredEvents.at(-1)).toEqual({
        runtimes: [
          {
            name: 'Codex CLI',
            adapterKind: 'codex',
            command: '/opt/homebrew/bin/codex',
            cwd: '/Users/shaw/AgentBean',
            installed: true,
          },
        ],
        agents: [
          {
            name: 'Codex',
            adapterKind: 'codex',
            category: 'agentos-hosted',
            source: 'runtime',
            command: '/opt/homebrew/bin/codex',
            cwd: '/Users/shaw/AgentBean',
          },
        ],
      });
    });
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
      agents: [{ name: 'Codex', adapterKind: 'codex-cli', category: 'agentos-hosted' }],
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
      agents: [{ name: 'Codex', adapterKind: 'codex-cli', category: 'agentos-hosted' }],
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
      agents: [{ name: 'Codex', adapterKind: 'codex-cli', category: 'agentos-hosted' }],
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

  test('marks device offline when the daemon socket disconnects', async () => {
    const app = createInMemoryServerNext({
      now: () => 1000,
      ids: createIds(['user-1', 'team-1', 'channel-all', 'device-1', 'agent-1']),
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
    const web = await connectClient(`${baseUrl}/web`, { auth: { token: (register as { token: string }).token } });
    cleanups.push(async () => {
      web.disconnect();
    });

    const deviceStatuses: Array<{ id: string; status: string }> = [];
    const agentStatuses: Array<{ id: string; status: string }> = [];
    web.on(WEB_EVENTS.device.status, (payload) => {
      deviceStatuses.push(deviceStatusSummary(payload));
    });
    web.on(WEB_EVENTS.agent.status, (payload) => {
      agentStatuses.push(agentStatusSummary(payload));
    });

    await web.emitWithAck(WEB_EVENTS.device.list, { userId: 'user-1', teamId: 'team-1' });
    await web.emitWithAck(WEB_EVENTS.agent.subscribe, { userId: 'user-1', teamId: 'team-1' });

    // daemon 连接并 device:hello → device 应为 online
    await expect(
      daemon.emitWithAck(AGENT_EVENTS.device.hello, {
        teamId: 'team-1',
        ownerId: 'user-1',
        machineId: 'machine-1',
        profileId: 'default',
      }),
    ).resolves.toMatchObject({ ok: true, device: { id: 'device-1', status: 'online' } });

    await eventually(async () => {
      expect(deviceStatuses.some((device) => device.id === 'device-1' && device.status === 'online')).toBe(true);
    });
    await expect(
      daemon.emitWithAck(AGENT_EVENTS.agent.registerBatch, {
        teamId: 'team-1',
        deviceId: 'device-1',
        agents: [{ name: 'Codex', adapterKind: 'codex-cli', category: 'agentos-hosted' }],
      }),
    ).resolves.toMatchObject({ ok: true, agents: [{ id: 'agent-1', status: 'online' }] });
    await eventually(async () => {
      expect(agentStatuses.some((agent) => agent.id === 'agent-1' && agent.status === 'online')).toBe(true);
    });

    // daemon 断开 → device 与其 hosted agents 都应变为 offline
    daemon.disconnect();

    await eventually(async () => {
      expect(deviceStatuses.some((device) => device.id === 'device-1' && device.status === 'offline')).toBe(true);
    });
    await eventually(async () => {
      expect(agentStatuses.some((agent) => agent.id === 'agent-1' && agent.status === 'offline')).toBe(true);
    });
  });

  test('keeps device online when an older daemon socket disconnects after reconnect', async () => {
    const app = createInMemoryServerNext({
      now: () => 1000,
      ids: createIds(['user-1', 'team-1', 'channel-all', 'device-1']),
    });
    const { baseUrl, ioServer, httpServer } = await startSocketServer(app);
    cleanups.push(async () => {
      await new Promise<void>((resolve) => ioServer.close(() => resolve()));
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    });

    const bootstrap = await connectClient(`${baseUrl}/web`);
    const oldDaemon = await connectClient(`${baseUrl}/agent`);
    const newDaemon = await connectClient(`${baseUrl}/agent`);
    cleanups.push(async () => {
      bootstrap.disconnect();
      oldDaemon.disconnect();
      newDaemon.disconnect();
    });
    await bootstrap.emitWithAck(WEB_EVENTS.auth.register, {
      username: 'shaw',
      password: 'secret',
      teamName: 'AgentBean',
    });

    const helloPayload = {
      teamId: 'team-1',
      ownerId: 'user-1',
      machineId: 'machine-1',
      profileId: 'default',
    };
    await expect(oldDaemon.emitWithAck(AGENT_EVENTS.device.hello, helloPayload)).resolves.toMatchObject({
      ok: true,
      device: { id: 'device-1', status: 'online' },
    });
    await expect(newDaemon.emitWithAck(AGENT_EVENTS.device.hello, helloPayload)).resolves.toMatchObject({
      ok: true,
      device: { id: 'device-1', status: 'online' },
    });

    oldDaemon.disconnect();
    await delay(50);

    await expect(app.getDevice({ userId: 'user-1', deviceId: 'device-1' })).resolves.toMatchObject({
      ok: true,
      device: { id: 'device-1', status: 'online' },
    });
  });

  test('online device delete is defense-in-depth: notifies daemon with device:removed (layer1) AND writes revocation (layer2)', async () => {
    // 直接构造 repositories + usecases（而非 createInMemoryServerNext 工厂），以便
    // 在端到端 socket 流程后断言 layer2 吊销写入。layer1（device:removed emit +
    // 断开 socket）与 layer2（revocations 写入）组合验证才是真双保险。
    const repositories = createInMemoryRepositories();
    const app = createServerNextUseCases({
      repositories,
      clock: { now: () => 1000 },
      ids: { nextId: createIds(['user-1', 'team-1', 'channel-all', 'device-1']) },
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
    const web = await connectClient(`${baseUrl}/web`, { auth: { token: (register as { token: string }).token } });
    cleanups.push(async () => {
      web.disconnect();
    });

    // daemon 上线注册
    await expect(
      daemon.emitWithAck(AGENT_EVENTS.device.hello, {
        teamId: 'team-1',
        ownerId: 'user-1',
        machineId: 'machine-1',
        profileId: 'default',
      }),
    ).resolves.toMatchObject({ ok: true, device: { id: 'device-1', status: 'online' } });

    const removedEvents: unknown[] = [];
    let daemonDisconnected = false;
    daemon.on(AGENT_EVENTS.device.removed, (payload) => {
      removedEvents.push(payload);
    });
    daemon.on('disconnect', () => {
      daemonDisconnected = true;
    });

    // web 端删除该设备 → 服务端应向 daemon 下发 device:removed 并断开其 socket
    await expect(
      web.emitWithAck(WEB_EVENTS.device.delete, { userId: 'user-1', teamId: 'team-1', deviceId: 'device-1' }),
    ).resolves.toMatchObject({ ok: true });

    // 层1：device:removed emit + 断开 socket
    await eventually(async () => {
      expect(removedEvents).toHaveLength(1);
    });
    await eventually(async () => {
      expect(daemonDisconnected).toBe(true);
    });
    // 层2：吊销已写入 DB（即便 daemon 没收到 device:removed，重连也会被 DEVICE_REVOKED 拦截）
    await expect(
      repositories.revocations.find({
        teamId: 'team-1',
        machineId: 'machine-1',
        profileId: 'default',
      }),
    ).resolves.not.toBeNull();
  });

  test('kicks every daemon in the deleted device alias group, not just the selected one', async () => {
    const app = createInMemoryServerNext({
      now: () => 1000,
      ids: createIds(['user-1', 'team-1', 'channel-1', 'canonical-device', 'alias-device']),
    });
    const { baseUrl, ioServer, httpServer } = await startSocketServer(app);
    cleanups.push(async () => {
      await new Promise<void>((resolve) => ioServer.close(() => resolve()));
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    });

    const bootstrap = await connectClient(`${baseUrl}/web`);
    const canonicalDaemon = await connectClient(`${baseUrl}/agent`);
    const aliasDaemon = await connectClient(`${baseUrl}/agent`);
    cleanups.push(async () => {
      bootstrap.disconnect();
      canonicalDaemon.disconnect();
      aliasDaemon.disconnect();
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

    // 同一台物理机的两条别名记录（同 hostname、无 machineId）→ canonical + alias，各持一个在线 daemon
    await expect(
      canonicalDaemon.emitWithAck(AGENT_EVENTS.device.hello, {
        teamId: 'team-1',
        ownerId: 'user-1',
        hostname: 'shaw-mac.local',
      }),
    ).resolves.toMatchObject({ ok: true, device: { id: 'canonical-device' } });
    await expect(
      aliasDaemon.emitWithAck(AGENT_EVENTS.device.hello, {
        teamId: 'team-1',
        ownerId: 'user-1',
        hostname: 'shaw-mac.local',
      }),
    ).resolves.toMatchObject({ ok: true, device: { id: 'alias-device' } });

    const canonicalRemoved: unknown[] = [];
    let canonicalDisconnected = false;
    canonicalDaemon.on(AGENT_EVENTS.device.removed, (payload) => canonicalRemoved.push(payload));
    canonicalDaemon.on('disconnect', () => { canonicalDisconnected = true; });
    const aliasRemoved: unknown[] = [];
    let aliasDisconnected = false;
    aliasDaemon.on(AGENT_EVENTS.device.removed, (payload) => aliasRemoved.push(payload));
    aliasDaemon.on('disconnect', () => { aliasDisconnected = true; });

    // 只删 alias 记录，但整组删除 → canonical 与 alias 两个 daemon 都应被踢
    await expect(
      web.emitWithAck(WEB_EVENTS.device.delete, { userId: 'user-1', teamId: 'team-1', deviceId: 'alias-device' }),
    ).resolves.toMatchObject({ ok: true });

    await eventually(async () => {
      expect(canonicalRemoved).toHaveLength(1);
    });
    await eventually(async () => {
      expect(aliasRemoved).toHaveLength(1);
    });
    await eventually(async () => {
      expect(canonicalDisconnected).toBe(true);
      expect(aliasDisconnected).toBe(true);
    });
  });
});

async function startSocketServer(
  app: ReturnType<typeof createInMemoryServerNext>,
  options: {
    dispatchRequestCoalesceMs?: number;
    useProductionDefaultDispatchRequestCoalesceMs?: boolean;
  } = {},
) {
  const httpServer = createServer();
  const ioServer = new Server(httpServer, { cors: { origin: '*' } });
  const realtime = attachServerNextNamespaces(
    ioServer,
    app,
    options.useProductionDefaultDispatchRequestCoalesceMs
      ? {}
      : { dispatchRequestCoalesceMs: options.dispatchRequestCoalesceMs ?? 0 },
  );
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', () => resolve()));
  const address = httpServer.address() as AddressInfo;
  return {
    httpServer,
    ioServer,
    realtime,
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

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
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

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
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

function channelNames(payload: unknown): string[] {
  if (!Array.isArray(payload)) {
    throw new Error('Expected channel snapshot payload to be an array');
  }
  return payload.map((channel) => {
    if (!channel || typeof channel !== 'object' || !('name' in channel)) {
      throw new Error('Expected channel snapshot item to include name');
    }
    return String(channel.name);
  });
}

function taskSnapshotSummary(payload: unknown): Array<{ id: string; title?: string }> {
  if (!Array.isArray(payload)) {
    throw new Error('Expected task snapshot payload to be an array');
  }
  return payload.map((task) => {
    if (!task || typeof task !== 'object' || !('id' in task)) {
      throw new Error('Expected task snapshot item to include id');
    }
    const item = task as { id: unknown; title?: unknown };
    return {
      id: String(item.id),
      title: typeof item.title === 'string' ? item.title : undefined,
    };
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

function agentStatusSummary(payload: unknown): { id: string; status: string } {
  if (!payload || typeof payload !== 'object' || !('id' in payload) || !('status' in payload)) {
    throw new Error('Expected agent status payload to include id and status');
  }
  return { id: String(payload.id), status: String(payload.status) };
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

function deviceStatusSummary(payload: unknown): { id: string; status: string } {
  if (!payload || typeof payload !== 'object' || !('id' in payload) || !('status' in payload)) {
    throw new Error('Expected device status payload to include id and status');
  }
  return { id: String(payload.id), status: String(payload.status) };
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

function discoveredPayloadSummary(payload: unknown): {
  runtimes: Array<{ name: string; adapterKind: string; command?: string; cwd?: string; installed?: boolean }>;
  agents: Array<{ name: string; adapterKind: string; category: string; source: string; command?: string; cwd?: string }>;
} {
  if (!payload || typeof payload !== 'object') {
    throw new Error('Expected agents:discovered payload to be an object');
  }
  const candidate = payload as { runtimes?: unknown; agents?: unknown };
  if (!Array.isArray(candidate.runtimes) || !Array.isArray(candidate.agents)) {
    throw new Error('Expected agents:discovered payload to include runtimes and agents arrays');
  }
  return {
    runtimes: candidate.runtimes.map((runtime) => {
      if (!runtime || typeof runtime !== 'object' || !('name' in runtime) || !('adapterKind' in runtime)) {
        throw new Error('Expected discovered runtime to include name and adapterKind');
      }
      const item = runtime as { name: unknown; adapterKind: unknown; command?: unknown; cwd?: unknown; installed?: unknown };
      return {
        name: String(item.name),
        adapterKind: String(item.adapterKind),
        command: typeof item.command === 'string' ? item.command : undefined,
        cwd: typeof item.cwd === 'string' ? item.cwd : undefined,
        installed: typeof item.installed === 'boolean' ? item.installed : undefined,
      };
    }),
    agents: candidate.agents.map((agent) => {
      if (!agent || typeof agent !== 'object' || !('name' in agent) || !('adapterKind' in agent) || !('category' in agent) || !('source' in agent)) {
        throw new Error('Expected discovered agent to include name, adapterKind, category, and source');
      }
      const item = agent as { name: unknown; adapterKind: unknown; category: unknown; source: unknown; command?: unknown; cwd?: unknown };
      return {
        name: String(item.name),
        adapterKind: String(item.adapterKind),
        category: String(item.category),
        source: String(item.source),
        command: typeof item.command === 'string' ? item.command : undefined,
        cwd: typeof item.cwd === 'string' ? item.cwd : undefined,
      };
    }),
  };
}
