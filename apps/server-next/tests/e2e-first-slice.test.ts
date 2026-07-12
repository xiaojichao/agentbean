import { createServer, type Server as HttpServer } from 'node:http';
import { createRequire } from 'node:module';
import { AddressInfo } from 'node:net';
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { AGENT_EVENTS, type DispatchRequestDto } from '../../../packages/contracts/src/index';
import { createDaemonProtocolClient, type DaemonProtocolSocket } from '../../daemon-next/src/index';
import { createWebSocketClient, type WebSocketTransport } from '../../web-next/src/index';
import { createInMemoryServerNext } from '../src/index';
import { attachServerNextNamespaces } from '../src/transport/socket-server';

type SocketIoServerConstructor = new (server: HttpServer, options?: Record<string, unknown>) => {
  of(namespace: string): unknown;
  close(callback?: () => void): void;
};
type ClientSocket = WebSocketTransport &
  DaemonProtocolSocket & {
    connect(): void;
    disconnect(): void;
    emit(event: string, payload: unknown): void;
    on(event: string, handler: (...args: unknown[]) => void): void;
  };

const requireFromServer = createRequire(new URL('../package.json', import.meta.url));
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

describe('AgentBean Next first-slice smoke', () => {
  test('runs preview flow with runtime capability -> custom agent -> message -> daemon reply', async () => {
    const app = createInMemoryServerNext({
      now: () => 1100,
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
        'workspace-run-1',
        'reply-1',
      ]),
    });
    const { baseUrl, httpServer, ioServer } = await startSocketServer(app);
    cleanups.push(async () => {
      await new Promise<void>((resolve) => ioServer.close(() => resolve()));
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    });

    const webSocket = await connectClient(`${baseUrl}/web`);
    const agentSocket = await connectClient(`${baseUrl}/agent`);
    cleanups.push(async () => {
      webSocket.disconnect();
      agentSocket.disconnect();
    });

    const web = createWebSocketClient(webSocket);
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'agentbean-next-e2e-')));
    await expect(
      web.register({
        username: 'shaw',
        password: 'secret',
        teamName: 'AgentBean',
      }),
    ).resolves.toMatchObject({
      ok: true,
      user: { id: 'user-1' },
      currentTeam: { id: 'team-1' },
      defaultChannel: { id: 'channel-1' },
    });

    const resolvedEnvRefs: unknown[] = [];
    const daemon = createDaemonProtocolClient({
      socket: agentSocket,
      executor: async (request) => ({
        body: `preview:${request.prompt}`,
        workspaceRun: {
          cwd,
          command: '/opt/homebrew/bin/codex --model gpt-5.4',
          logExcerpt: 'OPENAI_API_KEY=[redacted]\nfinished',
          exitCode: 0,
          startedAt: 1000,
          completedAt: 1100,
        },
      }),
      device: {
        teamId: 'team-1',
        ownerId: 'user-1',
        machineId: 'machine-1',
        profileId: 'default',
      },
      runtimes: [
        {
          adapterKind: 'codex',
          name: 'Codex CLI',
          command: '/opt/homebrew/bin/codex',
          cwd,
          installed: true,
        },
      ],
      agents: [],
      envResolver: async (envRef) => {
        resolvedEnvRefs.push(envRef);
        return { OPENAI_API_KEY: 'secret-value' };
      },
    });
    await daemon.start();

    await expect(
      web.createAgent({
        userId: 'user-1',
        teamId: 'team-1',
        deviceId: 'device-1',
        runtimeId: 'runtime-1',
        name: 'Codex',
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

    await expect(
      web.sendMessage({
        userId: 'user-1',
        teamId: 'team-1',
        channelId: 'channel-1',
        body: '@Codex hello',
      }),
    ).resolves.toMatchObject({
      ok: true,
      message: { id: 'message-1', senderKind: 'human' },
      dispatches: [{ id: 'dispatch-1', agentId: 'agent-1' }],
    });

    await eventually(async () => {
      await expect(app.listChannelMessages({ channelId: 'channel-1', limit: 10 })).resolves.toMatchObject({
        ok: true,
        messages: [
          { id: 'message-1', senderKind: 'human', body: '@Codex hello' },
          {
            id: 'reply-1',
            senderKind: 'agent',
            body: 'preview:@Codex hello',
            workspaceRun: {
              cwd,
              command: '/opt/homebrew/bin/codex --model gpt-5.4',
              logExcerpt: 'OPENAI_API_KEY=[redacted]\nfinished',
              exitCode: 0,
              startedAt: 1000,
              completedAt: 1100,
            },
          },
        ],
      });
    });
    expect(resolvedEnvRefs).toEqual([{ agentId: 'agent-1', teamId: 'team-1' }]);
  }, 15_000);

  test('runs register -> daemon hello -> agent batch -> message send -> dispatch result', async () => {
    const app = createInMemoryServerNext({
      now: () => 1200,
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
    const { baseUrl, httpServer, ioServer } = await startSocketServer(app);
    cleanups.push(async () => {
      await new Promise<void>((resolve) => ioServer.close(() => resolve()));
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    });

    const webSocket = await connectClient(`${baseUrl}/web`);
    const agentSocket = await connectClient(`${baseUrl}/agent`);
    cleanups.push(async () => {
      webSocket.disconnect();
      agentSocket.disconnect();
    });

    const web = createWebSocketClient(webSocket);
    const registerAck = await web.register({
      username: 'shaw',
      password: 'secret',
      teamName: 'AgentBean',
    });
    expect(registerAck).toMatchObject({
      ok: true,
      user: { id: 'user-1' },
      currentTeam: { id: 'team-1' },
      defaultChannel: { id: 'channel-1' },
    });

    const daemon = createDaemonProtocolClient({
      socket: agentSocket,
      executor: async (request) => `reply:${request.prompt}`,
      device: {
        teamId: 'team-1',
        ownerId: 'user-1',
        machineId: 'machine-1',
        profileId: 'default',
      },
      runtimes: [{ adapterKind: 'codex-cli', name: 'Codex CLI' }],
      agents: [{ name: 'Codex', adapterKind: 'codex-cli', category: 'agentos-hosted' }],
    });
    await daemon.start();

    const sendAck = await web.sendMessage({
      userId: 'user-1',
      teamId: 'team-1',
      channelId: 'channel-1',
      body: '@Codex hello',
    });
    expect(sendAck).toMatchObject({
      ok: true,
      message: { id: 'message-1', senderKind: 'human' },
      dispatches: [{ id: 'dispatch-1', agentId: 'agent-1' }],
    });

    await eventually(async () => {
      await expect(app.listChannelMessages({ channelId: 'channel-1', limit: 10 })).resolves.toMatchObject({
        ok: true,
        messages: [
          { id: 'message-1', senderKind: 'human', body: '@Codex hello' },
          { id: 'reply-1', senderKind: 'agent', body: 'reply:@Codex hello' },
        ],
      });
    });
  });

  test('persists a human message without dispatch when no agent is online', async () => {
    const app = createInMemoryServerNext({
      now: () => 1300,
      ids: createIds(['user-1', 'team-1', 'channel-1', 'message-1']),
    });
    const { baseUrl, httpServer, ioServer } = await startSocketServer(app);
    cleanups.push(async () => {
      await new Promise<void>((resolve) => ioServer.close(() => resolve()));
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    });

    const webSocket = await connectClient(`${baseUrl}/web`);
    cleanups.push(async () => {
      webSocket.disconnect();
    });
    const web = createWebSocketClient(webSocket);

    await web.register({ username: 'shaw', password: 'secret', teamName: 'AgentBean' });
    await expect(
      web.sendMessage({
        userId: 'user-1',
        teamId: 'team-1',
        channelId: 'channel-1',
        body: 'hello',
      }),
    ).resolves.toMatchObject({
      ok: true,
      message: { id: 'message-1', senderKind: 'human' },
      dispatches: [],
      route: { kind: 'no-dispatch', reason: 'no-online-agent' },
    });
    await expect(app.listChannelMessages({ channelId: 'channel-1', limit: 10 })).resolves.toMatchObject({
      ok: true,
      messages: [{ id: 'message-1', body: 'hello' }],
    });
  });

  test('daemon reconnect refreshes device and agent snapshots without clones', async () => {
    const app = createInMemoryServerNext({
      now: () => 1400,
      ids: createIds(['user-1', 'team-1', 'channel-1', 'device-1', 'runtime-1', 'agent-1', 'runtime-2']),
    });
    const { baseUrl, httpServer, ioServer } = await startSocketServer(app);
    cleanups.push(async () => {
      await new Promise<void>((resolve) => ioServer.close(() => resolve()));
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    });

    const webSocket = await connectClient(`${baseUrl}/web`);
    cleanups.push(async () => {
      webSocket.disconnect();
    });
    const web = createWebSocketClient(webSocket);
    await web.register({ username: 'shaw', password: 'secret', teamName: 'AgentBean' });

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const agentSocket = await connectClient(`${baseUrl}/agent`);
      cleanups.push(async () => {
        agentSocket.disconnect();
      });
      await createDaemonProtocolClient({
        socket: agentSocket,
        executor: async (request) => `reply:${request.prompt}`,
        device: { teamId: 'team-1', ownerId: 'user-1', machineId: 'machine-1', profileId: 'default' },
        runtimes: [{ adapterKind: 'codex-cli', name: 'Codex CLI' }],
        agents: [{ name: 'Codex', adapterKind: 'codex-cli', category: 'agentos-hosted' }],
      }).start();
    }

    await expect(app.listVisibleAgents({ teamId: 'team-1' })).resolves.toMatchObject({
      ok: true,
      agents: [{ id: 'agent-1', status: 'online' }],
    });
    const visible = await app.listVisibleAgents({ teamId: 'team-1' });
    expect((visible as { agents: unknown[] }).agents).toHaveLength(1);
  });
});

async function startSocketServer(app: ReturnType<typeof createInMemoryServerNext>) {
  const httpServer = createServer();
  const ioServer = new Server(httpServer, { cors: { origin: '*' } });
  attachServerNextNamespaces(ioServer, app, { dispatchRequestCoalesceMs: 0 });
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', () => resolve()));
  const address = httpServer.address() as AddressInfo;
  return {
    httpServer,
    ioServer,
    baseUrl: `http://127.0.0.1:${address.port}`,
  };
}

async function connectClient(url: string): Promise<ClientSocket> {
  const socket = createClient(url, {
    transports: ['websocket'],
    forceNew: true,
    reconnection: false,
  });
  await new Promise<void>((resolve, reject) => {
    socket.on('connect', () => resolve());
    socket.on('connect_error', (error) => reject(error));
    socket.connect();
  });
  return socket;
}

async function eventually(assertion: () => Promise<void>, attempts = 1000): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 10));
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
