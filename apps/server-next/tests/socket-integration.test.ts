import { createServer, type Server as HttpServer } from 'node:http';
import { createRequire } from 'node:module';
import { AddressInfo } from 'node:net';
import { afterEach, describe, expect, test } from 'vitest';
import { AGENT_EVENTS, WEB_EVENTS } from '../../../packages/contracts/src/index';
import { createServerNextUseCases } from '../src/application/usecases';
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
      dispatch: { id: 'dispatch-1', status: 'completed' },
      message: { id: 'reply-1', senderKind: 'agent', body: 'done' },
    });
  });

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
