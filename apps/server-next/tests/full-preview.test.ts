import { createRequire } from 'node:module';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { WEB_EVENTS } from '../../../packages/contracts/src/index';
import {
  authenticatePreviewWebSession,
  parseAgentBeanNextPreviewConfig,
  startAgentBeanNextPreview,
  type PreviewSocketLike,
} from '../src/full-preview';

type ClientSocket = {
  connect(): void;
  disconnect(): void;
  emitWithAck(event: string, payload: unknown): Promise<unknown>;
  on(event: string, handler: (...args: unknown[]) => void): void;
};

const requireFromServer = createRequire(new URL('../../server/package.json', import.meta.url));
const { io: createClient } = requireFromServer('socket.io-client') as {
  io(url: string, options?: Record<string, unknown>): ClientSocket;
};

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.();
  }
});

describe('AgentBean Next full preview launcher', () => {
  test('parses full preview defaults and overrides', () => {
    expect(
      parseAgentBeanNextPreviewConfig({
        hostname: 'host.local',
        env: {
          AGENTBEAN_NEXT_DATA_DIR: '/tmp/agentbean-next',
          AGENTBEAN_NEXT_PREVIEW_USERNAME: 'preview',
          AGENTBEAN_NEXT_PREVIEW_PASSWORD: 'secret',
          AGENTBEAN_NEXT_PREVIEW_TEAM: 'Preview Team',
          AGENTBEAN_NEXT_PROFILE_ID: 'preview-profile',
          AGENTBEAN_NEXT_FALLBACK_PREFIX: 'preview:',
          AGENTBEAN_NEXT_SESSION_SECRET: 'preview-secret',
        },
        argv: ['--port', '0'],
      }),
    ).toEqual({
      host: '127.0.0.1',
      port: 0,
      dataDir: '/tmp/agentbean-next',
      sessionSecret: 'preview-secret',
      username: 'preview',
      password: 'secret',
      teamName: 'Preview Team',
      machineId: 'agentbean-next-preview:host.local',
      profileId: 'preview-profile',
      hostname: 'host.local',
      fallbackPrefix: 'preview:',
      webEntry: 'preview',
    });
  });

  test('forwards web entry override to enable App Router serving', () => {
    expect(
      parseAgentBeanNextPreviewConfig({
        hostname: 'host.local',
        env: {
          AGENTBEAN_NEXT_DATA_DIR: '/tmp/agentbean-next',
          AGENTBEAN_NEXT_WEB_ENTRY: 'app',
        },
        argv: ['--port', '0'],
      }).webEntry,
    ).toBe('app');
  });

  test('uses a stable preview machine id by default', () => {
    expect(
      parseAgentBeanNextPreviewConfig({
        hostname: 'shaw-mac.local',
        env: {
          AGENTBEAN_NEXT_DATA_DIR: '/tmp/agentbean-next',
          AGENTBEAN_NEXT_SESSION_SECRET: 'preview-secret',
        },
        argv: ['--port', '0'],
      }).machineId,
    ).toBe('agentbean-next-preview:shaw-mac.local');
  });

  test('logs in when the bootstrapped preview user already exists', async () => {
    const socket = new FakePreviewSocket([
      { ok: false, error: 'CONFLICT', message: 'Username already exists' },
      {
        ok: true,
        user: { id: 'user-1', username: 'shaw', primaryTeamId: 'team-1' },
        currentTeam: {
          id: 'team-1',
          name: 'AgentBean',
          path: 'agentbean',
          visibility: 'private',
          ownerId: 'user-1',
          currentUserRole: 'owner',
          createdAt: 1000,
        },
      },
    ]);

    await expect(
      authenticatePreviewWebSession(socket, {
        username: 'shaw',
        password: 'secret',
        teamName: 'AgentBean',
      }),
    ).resolves.toMatchObject({
      user: { id: 'user-1' },
      currentTeam: { id: 'team-1' },
    });
    expect(socket.calls).toEqual([
      [WEB_EVENTS.auth.register, { username: 'shaw', password: 'secret', teamName: 'AgentBean' }],
      [WEB_EVENTS.auth.login, { username: 'shaw', password: 'secret' }],
    ]);
  });

  test('starts a SQLite server and attaches daemon-next to the preview team', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'agentbean-next-full-preview-'));
    const handle = await startAgentBeanNextPreview({
      config: {
        host: '127.0.0.1',
        port: 0,
        dataDir,
        sessionSecret: 'test-secret',
        username: 'shaw',
        password: 'secret',
        teamName: 'AgentBean',
        profileId: 'agentbean-next-preview',
        hostname: 'host.local',
        fallbackPrefix: 'preview:',
      },
      executor: async (request) => `preview:${request.prompt}`,
    });
    cleanups.push(() => handle.close());

    const web = await connectClient(`${handle.baseUrl}/web`);
    cleanups.push(async () => {
      web.disconnect();
    });

    await expect(
      web.emitWithAck(WEB_EVENTS.device.list, {
        userId: handle.user.id,
        teamId: handle.currentTeam.id,
      }),
    ).resolves.toMatchObject({
      ok: true,
      devices: [{ status: 'online', name: 'host.local' }],
    });
  });
});

class FakePreviewSocket implements Pick<PreviewSocketLike, 'emitWithAck'> {
  readonly calls: Array<[string, unknown]> = [];
  private index = 0;

  constructor(private readonly acks: unknown[]) {}

  async emitWithAck(event: string, payload: unknown): Promise<unknown> {
    this.calls.push([event, payload]);
    const ack = this.acks[this.index];
    this.index += 1;
    return ack;
  }
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
