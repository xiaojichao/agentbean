import { createRequire } from 'node:module';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
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

  test('serves team-scoped artifact upload, preview, and download over HTTP', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'agentbean-next-artifacts-'));
    const server = await startServerNextDevServer({
      Server,
      Database,
      config: { host: '127.0.0.1', port: 0, storage: 'sqlite', dataDir, sessionSecret: 'test-secret' },
    });
    cleanups.push(() => server.close());
    const ownerSocket = await connectClient(`${server.baseUrl}/web`);
    const outsiderSocket = await connectClient(`${server.baseUrl}/web`);
    cleanups.push(async () => {
      ownerSocket.disconnect();
      outsiderSocket.disconnect();
    });
    const owner = await ownerSocket.emitWithAck(WEB_EVENTS.auth.register, {
      username: 'shaw',
      password: 'secret',
      teamName: 'AgentBean',
    }) as {
      ok: true;
      token: string;
      currentTeam: { id: string };
      defaultChannel: { id: string };
    };
    const outsider = await outsiderSocket.emitWithAck(WEB_EVENTS.auth.register, {
      username: 'outsider',
      password: 'secret',
      teamName: 'Other',
    }) as { ok: true; token: string };

    const upload = await fetch(`${server.baseUrl}/api/teams/${owner.currentTeam.id}/artifacts/upload`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        token: owner.token,
        channelId: owner.defaultChannel.id,
        filename: 'reply.md',
        mimeType: 'text/markdown',
        contentBase64: Buffer.from('# hello artifact\n').toString('base64'),
      }),
    });
    expect(upload.status).toBe(201);
    const uploadJson = await upload.json() as {
      ok: true;
      artifact: { id: string; filename: string; previewUrl: string; downloadUrl: string };
    };
    expect(uploadJson).toMatchObject({
      ok: true,
      artifact: {
        filename: 'reply.md',
        previewUrl: `/api/teams/${owner.currentTeam.id}/artifacts/${uploadJson.artifact.id}/preview`,
        downloadUrl: `/api/teams/${owner.currentTeam.id}/artifacts/${uploadJson.artifact.id}/download`,
      },
    });

    const preview = await fetch(`${server.baseUrl}${uploadJson.artifact.previewUrl}?token=${encodeURIComponent(owner.token)}`);
    expect(preview.status).toBe(200);
    expect(preview.headers.get('content-type')).toContain('text/markdown');
    expect(preview.headers.get('content-disposition')).toContain('inline');
    await expect(preview.text()).resolves.toBe('# hello artifact\n');

    const download = await fetch(`${server.baseUrl}${uploadJson.artifact.downloadUrl}?token=${encodeURIComponent(owner.token)}`);
    expect(download.status).toBe(200);
    expect(download.headers.get('content-disposition')).toContain('attachment');
    expect(download.headers.get('content-disposition')).toContain('reply.md');

    const forbidden = await fetch(
      `${server.baseUrl}${uploadJson.artifact.previewUrl}?token=${encodeURIComponent(outsider.token)}`,
    );
    expect(forbidden.status).toBe(403);
  });

  test('accepts multipart artifact uploads over HTTP', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'agentbean-next-artifacts-multipart-'));
    const server = await startServerNextDevServer({
      Server,
      Database,
      config: { host: '127.0.0.1', port: 0, storage: 'sqlite', dataDir, sessionSecret: 'test-secret' },
    });
    cleanups.push(() => server.close());
    const ownerSocket = await connectClient(`${server.baseUrl}/web`);
    cleanups.push(async () => {
      ownerSocket.disconnect();
    });
    const owner = await ownerSocket.emitWithAck(WEB_EVENTS.auth.register, {
      username: 'shaw',
      password: 'secret',
      teamName: 'AgentBean',
    }) as {
      ok: true;
      token: string;
      currentTeam: { id: string };
      defaultChannel: { id: string };
    };

    const body = new FormData();
    body.append('token', owner.token);
    body.append('channelId', owner.defaultChannel.id);
    body.append('file', new Blob(['# hello multipart\n'], { type: 'text/markdown' }), 'reply.md');

    const upload = await fetch(`${server.baseUrl}/api/teams/${owner.currentTeam.id}/artifacts/upload`, {
      method: 'POST',
      body,
    });
    expect(upload.status).toBe(201);
    const uploadJson = await upload.json() as {
      ok: true;
      artifact: { id: string; filename: string; mimeType: string; previewUrl: string };
    };
    expect(uploadJson).toMatchObject({
      ok: true,
      artifact: {
        filename: 'reply.md',
        mimeType: 'text/markdown',
        previewUrl: `/api/teams/${owner.currentTeam.id}/artifacts/${uploadJson.artifact.id}/preview`,
      },
    });

    const preview = await fetch(`${server.baseUrl}${uploadJson.artifact.previewUrl}?token=${encodeURIComponent(owner.token)}`);
    expect(preview.status).toBe(200);
    expect(preview.headers.get('content-type')).toContain('text/markdown');
    await expect(preview.text()).resolves.toBe('# hello multipart\n');
  });

  test('serves authorized workspace run detail over HTTP', async () => {
    const app = {
      whoami: vi.fn(async () => makeSuccess({ user: { id: 'user-1', username: 'shaw', createdAt: 1 } })),
      getWorkspaceRunDetail: vi.fn(async () =>
        makeSuccess({
          workspaceRun: {
            id: 'run-1',
            teamId: 'team-1',
            channelId: 'channel-1',
            messageId: 'message-1',
            dispatchId: 'dispatch-1',
            agentId: 'agent-1',
            deviceId: 'device-1',
            status: 'succeeded',
            artifactIds: ['artifact-1'],
            cwd: '/Users/shaw/AgentBean',
            exitCode: 0,
            startedAt: 1000,
            completedAt: 2500,
            createdAt: 1,
            updatedAt: 2,
          },
          artifacts: [
            {
              id: 'artifact-1',
              teamId: 'team-1',
              channelId: 'channel-1',
              messageId: 'message-1',
              dispatchId: 'dispatch-1',
              workspaceRunId: 'run-1',
              filename: 'result.md',
              mimeType: 'text/markdown',
              sizeBytes: 42,
              relativePath: 'outputs/result.md',
              pathKind: 'workspace',
              createdAt: 2,
            },
          ],
        }),
      ),
    } as unknown as ServerNextUseCases;
    const server = await startServerNextDevServer({
      app,
      Server,
      config: { host: '127.0.0.1', port: 0, storage: 'memory', dataDir: '.agentbean-next-test', sessionSecret: 'test-secret' },
    });
    cleanups.push(() => server.close());

    const response = await fetch(`${server.baseUrl}/api/teams/team-1/workspace-runs/run-1?token=token-1`);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      workspaceRun: { id: 'run-1', cwd: '/Users/shaw/AgentBean' },
      artifacts: [{ id: 'artifact-1', relativePath: 'outputs/result.md' }],
    });
    expect(app.getWorkspaceRunDetail).toHaveBeenCalledWith({
      userId: 'user-1',
      teamId: 'team-1',
      runId: 'run-1',
    });
  });

  test('serves authorized team workspace runs over HTTP', async () => {
    const app = {
      whoami: vi.fn(async () => makeSuccess({ user: { id: 'user-1', username: 'shaw', createdAt: 1 } })),
      listTeamWorkspaceRuns: vi.fn(async () =>
        makeSuccess({
          runs: [
            {
              workspaceRun: {
                id: 'run-1',
                teamId: 'team-1',
                channelId: 'channel-1',
                messageId: 'message-1',
                dispatchId: 'dispatch-1',
                agentId: 'agent-1',
                deviceId: 'device-1',
                status: 'succeeded',
                artifactIds: ['artifact-1'],
                cwd: '/Users/shaw/AgentBean',
                command: 'npm test',
                exitCode: 0,
                startedAt: 1000,
                completedAt: 2500,
                createdAt: 1,
                updatedAt: 2,
              },
              artifacts: [
                {
                  id: 'artifact-1',
                  teamId: 'team-1',
                  channelId: 'channel-1',
                  messageId: 'message-1',
                  dispatchId: 'dispatch-1',
                  workspaceRunId: 'run-1',
                  filename: 'result.md',
                  mimeType: 'text/markdown',
                  sizeBytes: 42,
                  relativePath: 'outputs/result.md',
                  pathKind: 'workspace',
                  createdAt: 2,
                },
              ],
            },
          ],
        }),
      ),
    } as unknown as ServerNextUseCases;
    const server = await startServerNextDevServer({
      app,
      Server,
      config: { host: '127.0.0.1', port: 0, storage: 'memory', dataDir: '.agentbean-next-test', sessionSecret: 'test-secret' },
    });
    cleanups.push(() => server.close());

    const response = await fetch(`${server.baseUrl}/api/teams/team-1/workspace-runs?token=token-1`);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      teamId: 'team-1',
      runs: [
        {
          workspaceRun: {
            id: 'run-1',
            status: 'succeeded',
            cwd: '/Users/shaw/AgentBean',
            command: 'npm test',
          },
          artifacts: [
            {
              id: 'artifact-1',
              relativePath: 'outputs/result.md',
              previewUrl: '/api/teams/team-1/artifacts/artifact-1/preview',
              downloadUrl: '/api/teams/team-1/artifacts/artifact-1/download',
            },
          ],
        },
      ],
    });
    expect(app.listTeamWorkspaceRuns).toHaveBeenCalledWith({
      userId: 'user-1',
      teamId: 'team-1',
    });
  });

  test('serves authorized agent workspace runs over HTTP', async () => {
    const app = {
      whoami: vi.fn(async () => makeSuccess({ user: { id: 'user-1', username: 'shaw', createdAt: 1 } })),
      listAgentWorkspaceRuns: vi.fn(async () =>
        makeSuccess({
          runs: [
            {
              runId: 'run-1',
              createdAt: 1,
              updatedAt: 2,
              status: 'failed',
              cwd: '/Users/shaw/AgentBean',
              command: 'npm test',
              exitCode: 1,
              files: [
                {
                  id: 'artifact-1',
                  teamId: 'team-1',
                  channelId: 'channel-1',
                  messageId: 'message-1',
                  dispatchId: 'dispatch-1',
                  workspaceRunId: 'run-1',
                  filename: 'result.md',
                  mimeType: 'text/markdown',
                  sizeBytes: 42,
                  relativePath: 'outputs/result.md',
                  pathKind: 'workspace',
                  createdAt: 2,
                },
              ],
            },
          ],
        }),
      ),
    } as unknown as ServerNextUseCases;
    const server = await startServerNextDevServer({
      app,
      Server,
      config: { host: '127.0.0.1', port: 0, storage: 'memory', dataDir: '.agentbean-next-test', sessionSecret: 'test-secret' },
    });
    cleanups.push(() => server.close());

    const response = await fetch(`${server.baseUrl}/api/teams/team-1/agents/agent-1/workspace?token=token-1`);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      teamId: 'team-1',
      agentId: 'agent-1',
      runs: [
        {
          runId: 'run-1',
          status: 'failed',
          cwd: '/Users/shaw/AgentBean',
          command: 'npm test',
          files: [
            {
              id: 'artifact-1',
              relativePath: 'outputs/result.md',
              previewUrl: '/api/teams/team-1/artifacts/artifact-1/preview',
              downloadUrl: '/api/teams/team-1/artifacts/artifact-1/download',
            },
          ],
        },
      ],
    });
    expect(app.listAgentWorkspaceRuns).toHaveBeenCalledWith({
      userId: 'user-1',
      teamId: 'team-1',
      agentId: 'agent-1',
    });
  });

  test('keeps artifact file reads inside the configured data directory', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'agentbean-next-artifact-root-'));
    const outsideFilename = `${basename(dataDir)}-secret.txt`;
    writeFileSync(join(dataDir, '..', outsideFilename), 'outside secret');
    const app = {
      whoami: vi.fn(async () => makeSuccess({ user: { id: 'user-1', username: 'shaw', createdAt: 1 } })),
      getArtifactFile: vi.fn(async () =>
        makeSuccess({
          artifact: {
            id: 'artifact-1',
            teamId: 'team-1',
            channelId: 'channel-1',
            filename: 'secret.txt',
            mimeType: 'text/plain',
            sizeBytes: 14,
            createdAt: 1,
          },
          storagePath: `../${outsideFilename}`,
        }),
      ),
    } as unknown as ServerNextUseCases;
    const server = await startServerNextDevServer({
      app,
      Server,
      config: { host: '127.0.0.1', port: 0, storage: 'memory', dataDir, sessionSecret: 'test-secret' },
    });
    cleanups.push(() => server.close());

    const response = await fetch(`${server.baseUrl}/api/teams/team-1/artifacts/artifact-1/preview?token=token-1`);

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ ok: false, error: 'FILE_MISSING' });
    expect(app.getArtifactFile).toHaveBeenCalledWith({
      userId: 'user-1',
      teamId: 'team-1',
      artifactId: 'artifact-1',
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
      listDirectMessages: vi.fn(async () => makeSuccess({ dms: [] })),
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
