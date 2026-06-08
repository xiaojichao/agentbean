import { createRequire } from 'node:module';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { WEB_EVENTS, makeSuccess, type DispatchDto } from '../../../packages/contracts/src/index';
import { createInMemoryServerNext } from '../src/index';
import type { ServerNextUseCases } from '../src/application/usecases';
import { parseServerNextDevConfig, startServerNextDevServer } from '../src/dev-server';

type SocketIoServerConstructor = ConstructorParameters<typeof startServerNextDevServer>[0] extends { Server?: infer T }
  ? NonNullable<T>
  : never;
type BetterSqlite3Constructor = NonNullable<NonNullable<Parameters<typeof startServerNextDevServer>[0]>['Database']>;
type ClientSocket = {
  connect(): void;
  disconnect(): void;
  emitWithAck(event: string, payload: unknown): Promise<unknown>;
  on(event: string, handler: (...args: unknown[]) => void): void;
};

const requireFromServer = createRequire(new URL('../../server/package.json', import.meta.url));
const { Server } = requireFromServer('socket.io') as { Server: SocketIoServerConstructor };
const { io: createClient } = requireFromServer('socket.io-client') as {
  io(url: string, options?: Record<string, unknown>): ClientSocket;
};
const Database = requireFromServer('better-sqlite3') as BetterSqlite3Constructor;

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.();
  }
});

describe('server-next dev server entry', () => {
  test('parses host and port from args or env', () => {
    expect(
      parseServerNextDevConfig({
        env: {
          AGENTBEAN_NEXT_HOST: '0.0.0.0',
          AGENTBEAN_NEXT_DATA_DIR: '/tmp/env-data',
          AGENTBEAN_NEXT_SESSION_SECRET: 'secret-from-env',
        },
        argv: ['--port', '0', '--storage', 'sqlite', '--data-dir', '/tmp/arg-data'],
      }),
    ).toEqual({
      host: '0.0.0.0',
      port: 0,
      storage: 'sqlite',
      dataDir: '/tmp/arg-data',
      sessionSecret: 'secret-from-env',
    });
  });

  test('uses platform PORT for production-style startup defaults', () => {
    expect(
      parseServerNextDevConfig({
        env: {
          PORT: '4108',
          AGENTBEAN_NEXT_DATA_DIR: '/tmp/prod-agentbean-next',
          AGENTBEAN_NEXT_SESSION_SECRET: 'prod-secret',
        },
        argv: [],
      }),
    ).toEqual({
      host: '0.0.0.0',
      port: 4108,
      storage: 'sqlite',
      dataDir: '/tmp/prod-agentbean-next',
      sessionSecret: 'prod-secret',
    });
    expect(() =>
      parseServerNextDevConfig({
        env: { PORT: '4108', AGENTBEAN_NEXT_DATA_DIR: '/tmp/prod-agentbean-next' },
        argv: [],
      }),
    ).toThrow(
      'AGENTBEAN_NEXT_SESSION_SECRET',
    );
    expect(() =>
      parseServerNextDevConfig({
        env: { PORT: '4108', AGENTBEAN_NEXT_SESSION_SECRET: 'prod-secret' },
        argv: [],
      }),
    ).toThrow('AGENTBEAN_NEXT_DATA_DIR');
    expect(
      parseServerNextDevConfig({
        env: {
          PORT: '4108',
          AGENTBEAN_NEXT_STORAGE: 'memory',
          AGENTBEAN_NEXT_SESSION_SECRET: 'prod-secret',
        },
        argv: [],
      }),
    ).toEqual({
      host: '0.0.0.0',
      port: 4108,
      storage: 'memory',
      dataDir: join(process.cwd(), '.agentbean-next'),
      sessionSecret: 'prod-secret',
    });
  });

  test('starts a long-running Socket.IO server with healthz and web namespace', async () => {
    const app = createInMemoryServerNext({
      now: () => 1000,
      ids: createIds(['user-1', 'team-1', 'channel-1']),
    });
    const server = await startServerNextDevServer({
      app,
      Server,
      config: {
        host: '127.0.0.1',
        port: 0,
        storage: 'memory',
        dataDir: '.agentbean-next-test',
        sessionSecret: 'test-secret',
      },
    });
    cleanups.push(() => server.close());

    await expect(fetch(`${server.baseUrl}/healthz`).then((response) => response.json())).resolves.toEqual({
      ok: true,
      service: 'agentbean-next-server',
    });
    await expect(fetch(server.baseUrl).then((response) => response.text())).resolves.toContain('id="agent-create-form"');
    await expect(fetch(server.baseUrl).then((response) => response.text())).resolves.toContain('id="channel-create-form"');
    await expect(fetch(server.baseUrl).then((response) => response.text())).resolves.toContain('channel:create');
    await expect(fetch(server.baseUrl).then((response) => response.text())).resolves.toContain('auth:whoami');
    await expect(fetch(server.baseUrl).then((response) => response.text())).resolves.toContain('token: state.token');

    const web = await connectClient(`${server.baseUrl}/web`);
    cleanups.push(async () => {
      web.disconnect();
    });

    await expect(
      web.emitWithAck(WEB_EVENTS.auth.register, {
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
  });

  test('starts with SQLite file storage and preserves registered users across restarts', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'agentbean-next-sqlite-'));
    const first = await startServerNextDevServer({
      Server,
      Database,
      config: { host: '127.0.0.1', port: 0, storage: 'sqlite', dataDir, sessionSecret: 'test-secret' },
    });
    cleanups.push(() => first.close());

    const firstWeb = await connectClient(`${first.baseUrl}/web`);
    cleanups.push(async () => {
      firstWeb.disconnect();
    });
    await firstWeb.emitWithAck(WEB_EVENTS.auth.register, {
      username: 'shaw',
      password: 'secret',
      teamName: 'AgentBean',
    });
    firstWeb.disconnect();
    await first.close();
    cleanups.pop();
    cleanups.pop();

    const second = await startServerNextDevServer({
      Server,
      Database,
      config: { host: '127.0.0.1', port: 0, storage: 'sqlite', dataDir, sessionSecret: 'test-secret' },
    });
    cleanups.push(() => second.close());
    const secondWeb = await connectClient(`${second.baseUrl}/web`);
    cleanups.push(async () => {
      secondWeb.disconnect();
    });

    await expect(
      secondWeb.emitWithAck(WEB_EVENTS.auth.login, {
        username: 'shaw',
        password: 'secret',
      }),
    ).resolves.toMatchObject({
      ok: true,
      user: { username: 'shaw' },
      currentTeam: { name: 'AgentBean' },
    });
  });

  test('periodically marks timed out dispatches and broadcasts dispatch status', async () => {
    const timedOutDispatch = {
      id: 'dispatch-1',
      teamId: 'team-1',
      channelId: 'channel-1',
      messageId: 'message-1',
      agentId: 'agent-1',
      requestId: 'request-1',
      status: 'timed_out',
      error: 'DISPATCH_TIMEOUT',
      createdAt: 1000,
      updatedAt: 2000,
      completedAt: 2000,
    } satisfies DispatchDto;
    let returnedDispatch = false;
    let subscriptionsReady = false;
    const app = {
      listChannels: vi.fn(async (input: { teamId: string }) => makeSuccess({
        channels: [{ id: `${input.teamId}-channel`, teamId: input.teamId, visibility: 'public' }],
      })),
      failTimedOutDispatches: vi.fn(async () => {
        if (!subscriptionsReady || returnedDispatch) {
          return makeSuccess({ dispatches: [] });
        }
        returnedDispatch = true;
        return makeSuccess({ dispatches: [timedOutDispatch] });
      }),
    } as unknown as ServerNextUseCases;
    const server = await startServerNextDevServer({
      app,
      Server,
      config: {
        host: '127.0.0.1',
        port: 0,
        storage: 'memory',
        dataDir: '.agentbean-next-test',
        sessionSecret: 'test-secret',
      },
      dispatchTimeout: {
        timeoutMs: 25,
        intervalMs: 5,
      },
    });
    cleanups.push(() => server.close());
    const web = await connectClient(`${server.baseUrl}/web`);
    const otherTeamWeb = await connectClient(`${server.baseUrl}/web`);
    cleanups.push(async () => {
      web.disconnect();
      otherTeamWeb.disconnect();
    });

    const statuses: unknown[] = [];
    const otherTeamStatuses: unknown[] = [];
    web.on(WEB_EVENTS.message.dispatchStatus, (dispatch) => {
      statuses.push(dispatch);
    });
    otherTeamWeb.on(WEB_EVENTS.message.dispatchStatus, (dispatch) => {
      otherTeamStatuses.push(dispatch);
    });
    await web.emitWithAck(WEB_EVENTS.channel.subscribe, { userId: 'user-1', teamId: 'team-1' });
    await otherTeamWeb.emitWithAck(WEB_EVENTS.channel.subscribe, { userId: 'user-2', teamId: 'team-2' });
    subscriptionsReady = true;

    await eventually(() => {
      expect(app.failTimedOutDispatches).toHaveBeenCalled();
      expect(statuses).toEqual([timedOutDispatch]);
      expect(otherTeamStatuses).toEqual([]);
    });
  });
});

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
