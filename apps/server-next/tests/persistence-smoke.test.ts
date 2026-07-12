import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { afterEach, describe, expect, test } from 'vitest';
import { WEB_EVENTS } from '../../../packages/contracts/src/index';
import { startServerNextDevServer, type ServerNextDevServerHandle } from '../src/dev-server';

type ClientSocket = {
  connect(): void;
  disconnect(): void;
  timeout(ms: number): { emitWithAck(event: string, payload: unknown): Promise<unknown> };
  on(event: string, handler: (...args: unknown[]) => void): void;
  off(event: string, handler: (...args: unknown[]) => void): void;
};

const requireFromServer = createRequire(new URL('../package.json', import.meta.url));
const { io: createClient } = requireFromServer('socket.io-client') as {
  io(url: string, options?: Record<string, unknown>): ClientSocket;
};

const sockets: ClientSocket[] = [];
const servers: ServerNextDevServerHandle[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
  while (sockets.length > 0) {
    sockets.pop()?.disconnect();
  }
  while (servers.length > 0) {
    await servers.pop()?.close();
  }
  while (tempDirs.length > 0) {
    await rm(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe('AgentBean Next SQLite persistence smoke', () => {
  test('restores session, team, channel, and message after server restart', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'agentbean-next-persistence-'));
    tempDirs.push(dataDir);

    const firstServer = await startSqliteServer(dataDir);
    const firstWeb = await connectClient(`${firstServer.baseUrl}/web`);
    const registerAck = await emitAck(firstWeb, WEB_EVENTS.auth.register, {
      username: 'persistence-shaw',
      password: 'secret',
      teamName: 'AgentBean Persistence',
    });

    expect(registerAck).toMatchObject({
      ok: true,
      user: { id: expect.any(String) },
      currentTeam: { id: expect.any(String) },
      defaultChannel: { id: expect.any(String) },
      token: expect.any(String),
    });

    const session = registerAck as {
      token: string;
      user: { id: string };
      currentTeam: { id: string };
      defaultChannel: { id: string };
    };
    const body = 'SQLite restart persistence smoke';
    await expect(
      emitAck(firstWeb, WEB_EVENTS.message.send, {
        userId: session.user.id,
        teamId: session.currentTeam.id,
        channelId: session.defaultChannel.id,
        body,
      }),
    ).resolves.toMatchObject({
      ok: true,
      message: { body, channelId: session.defaultChannel.id },
    });

    firstWeb.disconnect();
    await firstServer.close();
    servers.pop();

    const secondServer = await startSqliteServer(dataDir);
    const secondWeb = await connectClient(`${secondServer.baseUrl}/web`);
    await expect(emitAck(secondWeb, WEB_EVENTS.auth.whoami, { token: session.token })).resolves.toMatchObject({
      ok: true,
      user: { id: session.user.id },
      currentTeam: { id: session.currentTeam.id },
    });
    await expect(
      emitAck(secondWeb, WEB_EVENTS.channel.join, {
        userId: session.user.id,
        teamId: session.currentTeam.id,
        channelId: session.defaultChannel.id,
      }),
    ).resolves.toMatchObject({
      ok: true,
      channel: { id: session.defaultChannel.id },
      messages: [expect.objectContaining({ body, channelId: session.defaultChannel.id })],
    });
  });
});

async function startSqliteServer(dataDir: string): Promise<ServerNextDevServerHandle> {
  const server = await startServerNextDevServer({
    config: {
      host: '127.0.0.1',
      port: 0,
      storage: 'sqlite',
      dataDir,
      sessionSecret: 'persistence-smoke-test-secret',
    },
  });
  servers.push(server);
  return server;
}

async function connectClient(url: string): Promise<ClientSocket> {
  const socket = createClient(url, {
    transports: ['websocket'],
    forceNew: true,
    reconnection: false,
    autoConnect: false,
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out connecting to ${url}`));
    }, 1_000);
    const cleanup = () => {
      clearTimeout(timer);
      socket.off('connect', onConnect);
      socket.off('connect_error', onError);
    };
    const onConnect = () => {
      cleanup();
      resolve();
    };
    const onError = (error: unknown) => {
      cleanup();
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    socket.on('connect', onConnect);
    socket.on('connect_error', onError);
    socket.connect();
  });
  sockets.push(socket);
  return socket;
}

async function emitAck(socket: ClientSocket, event: string, payload: unknown): Promise<unknown> {
  return socket.timeout(1_000).emitWithAck(event, payload);
}
