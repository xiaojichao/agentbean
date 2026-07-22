import { createRequire } from 'node:module';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { AGENT_EVENTS, WEB_EVENTS, makeSuccess, type DispatchDto } from '../../../packages/contracts/src/index';
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

const requireFromServer = createRequire(new URL('../package.json', import.meta.url));
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
      webEntry: 'preview',
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
      webEntry: 'app',
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
      webEntry: 'app',
    });
  });

  test('allows explicitly choosing the web entry mode', () => {
    expect(
      parseServerNextDevConfig({
        env: {
          PORT: '4108',
          AGENTBEAN_NEXT_DATA_DIR: '/tmp/prod-agentbean-next',
          AGENTBEAN_NEXT_SESSION_SECRET: 'prod-secret',
          AGENTBEAN_NEXT_WEB_ENTRY: 'preview',
        },
        argv: [],
      }).webEntry,
    ).toBe('preview');
    expect(() =>
      parseServerNextDevConfig({
        env: { AGENTBEAN_NEXT_WEB_ENTRY: 'legacy' },
        argv: [],
      }),
    ).toThrow('AGENTBEAN_NEXT_WEB_ENTRY');
  });

  test('configures the trusted Server Worker transport fail-closed', () => {
    expect(parseServerNextDevConfig({
      env: {
        AGENTBEAN_NEXT_SERVER_WORKER_POOL_ID: 'pool-1',
        AGENTBEAN_NEXT_SERVER_WORKER_PROVIDER_CREDENTIAL_REF: 'credential-ref-1',
        AGENTBEAN_NEXT_SERVER_WORKER_AUTH_TOKEN: 'server-worker-auth-token-at-least-32-chars',
      },
      argv: [],
    }).serverWorker).toEqual({
      workerPoolId: 'pool-1',
      providerCredentialRef: 'credential-ref-1',
      authToken: 'server-worker-auth-token-at-least-32-chars',
    });
    expect(() => parseServerNextDevConfig({
      env: { AGENTBEAN_NEXT_SERVER_WORKER_POOL_ID: 'pool-1' },
      argv: [],
    })).toThrow('SERVER_WORKER');
  });

  test('adds REST CORS headers for browser API requests derived from WEB_URL', async () => {
    const previousCorsOrigin = process.env.CORS_ORIGIN;
    const previousWebUrl = process.env.WEB_URL;
    const previousPort = process.env.PORT;
    delete process.env.CORS_ORIGIN;
    process.env.WEB_URL = 'https://agentbean.dev/app';
    delete process.env.PORT;

    const app = {} as unknown as ServerNextUseCases;
    const server = await startServerNextDevServer({
      app,
      Server,
      config: { host: '127.0.0.1', port: 0, storage: 'memory', dataDir: '.agentbean-next-test', sessionSecret: 'test-secret' },
    });
    cleanups.push(async () => {
      await server.close();
      if (previousCorsOrigin === undefined) delete process.env.CORS_ORIGIN;
      else process.env.CORS_ORIGIN = previousCorsOrigin;
      if (previousWebUrl === undefined) delete process.env.WEB_URL;
      else process.env.WEB_URL = previousWebUrl;
      if (previousPort === undefined) delete process.env.PORT;
      else process.env.PORT = previousPort;
    });

    const response = await fetch(`${server.baseUrl}/api/teams/team-1/workspace-runs?token=`, {
      headers: { Origin: 'https://agentbean.dev' },
    });

    expect(response.status).toBe(401);
    expect(response.headers.get('access-control-allow-origin')).toBe('https://agentbean.dev');
    await expect(response.json()).resolves.toMatchObject({ ok: false, error: 'UNAUTHENTICATED' });
  });

  test('allows the www origin variant when REST CORS is derived from WEB_URL', async () => {
    const previousCorsOrigin = process.env.CORS_ORIGIN;
    const previousWebUrl = process.env.WEB_URL;
    const previousPort = process.env.PORT;
    delete process.env.CORS_ORIGIN;
    process.env.WEB_URL = 'https://agentbean.dev/';
    delete process.env.PORT;

    const app = {} as unknown as ServerNextUseCases;
    const server = await startServerNextDevServer({
      app,
      Server,
      config: { host: '127.0.0.1', port: 0, storage: 'memory', dataDir: '.agentbean-next-test', sessionSecret: 'test-secret' },
    });
    cleanups.push(async () => {
      await server.close();
      if (previousCorsOrigin === undefined) delete process.env.CORS_ORIGIN;
      else process.env.CORS_ORIGIN = previousCorsOrigin;
      if (previousWebUrl === undefined) delete process.env.WEB_URL;
      else process.env.WEB_URL = previousWebUrl;
      if (previousPort === undefined) delete process.env.PORT;
      else process.env.PORT = previousPort;
    });

    const response = await fetch(`${server.baseUrl}/api/teams/team-1/workspace-runs?token=`, {
      headers: { Origin: 'https://www.agentbean.dev' },
    });

    expect(response.status).toBe(401);
    expect(response.headers.get('access-control-allow-origin')).toBe('https://www.agentbean.dev');
  });

  test('allows the default web-next dev origin for local REST CORS', async () => {
    const previousCorsOrigin = process.env.CORS_ORIGIN;
    const previousWebUrl = process.env.WEB_URL;
    const previousPort = process.env.PORT;
    delete process.env.CORS_ORIGIN;
    delete process.env.WEB_URL;
    delete process.env.PORT;

    const app = {} as unknown as ServerNextUseCases;
    const server = await startServerNextDevServer({
      app,
      Server,
      config: { host: '127.0.0.1', port: 0, storage: 'memory', dataDir: '.agentbean-next-test', sessionSecret: 'test-secret' },
    });
    cleanups.push(async () => {
      await server.close();
      if (previousCorsOrigin === undefined) delete process.env.CORS_ORIGIN;
      else process.env.CORS_ORIGIN = previousCorsOrigin;
      if (previousWebUrl === undefined) delete process.env.WEB_URL;
      else process.env.WEB_URL = previousWebUrl;
      if (previousPort === undefined) delete process.env.PORT;
      else process.env.PORT = previousPort;
    });

    const response = await fetch(`${server.baseUrl}/api/teams/team-1/workspace-runs`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'http://localhost:4101',
        'Access-Control-Request-Method': 'GET',
      },
    });

    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-origin')).toBe('http://localhost:4101');
  });

  test('answers production REST CORS preflight for the AgentBean web origin without explicit env', async () => {
    const previousCorsOrigin = process.env.CORS_ORIGIN;
    const previousWebUrl = process.env.WEB_URL;
    const previousPort = process.env.PORT;
    delete process.env.CORS_ORIGIN;
    delete process.env.WEB_URL;
    process.env.PORT = '4108';

    const app = {} as unknown as ServerNextUseCases;
    const server = await startServerNextDevServer({
      app,
      Server,
      config: { host: '127.0.0.1', port: 0, storage: 'memory', dataDir: '.agentbean-next-test', sessionSecret: 'test-secret' },
    });
    cleanups.push(async () => {
      await server.close();
      if (previousCorsOrigin === undefined) delete process.env.CORS_ORIGIN;
      else process.env.CORS_ORIGIN = previousCorsOrigin;
      if (previousWebUrl === undefined) delete process.env.WEB_URL;
      else process.env.WEB_URL = previousWebUrl;
      if (previousPort === undefined) delete process.env.PORT;
      else process.env.PORT = previousPort;
    });

    const response = await fetch(`${server.baseUrl}/api/teams/team-1/workspace-runs`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://www.agentbean.dev',
        'Access-Control-Request-Method': 'GET',
      },
    });

    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-origin')).toBe('https://www.agentbean.dev');
    expect(response.headers.get('access-control-allow-methods')).toContain('GET');
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

  test('serves the web-next app as root web entry while keeping preview available', async () => {
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
        webEntry: 'app',
      },
      webApp: {
        async handle(_request, response) {
          response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
          response.end('<title>AgentBean</title><main data-web-next-app="true"></main>');
        },
        async close() {
          return undefined;
        },
      },
    });
    cleanups.push(() => server.close());

    await expect(fetch(server.baseUrl).then((response) => response.text())).resolves.toContain('data-web-next-app');
    await expect(fetch(`${server.baseUrl}/preview`).then((response) => response.text())).resolves.toContain('id="agent-create-form"');
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

  test('reconciles persisted online devices to offline on SQLite startup', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'agentbean-next-stale-device-'));
    const first = await startServerNextDevServer({
      Server,
      Database,
      config: { host: '127.0.0.1', port: 0, storage: 'sqlite', dataDir, sessionSecret: 'test-secret' },
    });
    cleanups.push(() => first.close());

    const firstWeb = await connectClient(`${first.baseUrl}/web`);
    const daemon = await connectClient(`${first.baseUrl}/agent`);
    cleanups.push(async () => {
      daemon.disconnect();
      firstWeb.disconnect();
    });
    const registered = await firstWeb.emitWithAck(WEB_EVENTS.auth.register, {
      username: 'shaw',
      password: 'secret',
      teamName: 'AgentBean',
    }) as { ok: true; token: string; currentTeam: { id: string }; user: { id: string } };
    const hello = await daemon.emitWithAck(AGENT_EVENTS.device.hello, {
      teamId: registered.currentTeam.id,
      ownerId: registered.user.id,
      machineId: 'machine-1',
      profileId: 'default',
    }) as { ok: true; device: { id: string } };

    daemon.disconnect();
    firstWeb.disconnect();
    await first.close();
    cleanups.pop();
    cleanups.pop();

    const staleDb = new Database(join(dataDir, 'global.sqlite'));
    try {
      staleDb.prepare("UPDATE devices SET status = 'online' WHERE id = ?").run(hello.device.id);
    } finally {
      staleDb.close();
    }

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
    const login = await secondWeb.emitWithAck(WEB_EVENTS.auth.login, {
      username: 'shaw',
      password: 'secret',
    }) as { ok: true; currentTeam: { id: string }; user: { id: string } };

    await expect(
      secondWeb.emitWithAck(WEB_EVENTS.device.list, { userId: login.user.id, teamId: login.currentTeam.id }),
    ).resolves.toMatchObject({
      ok: true,
      devices: [{ id: hello.device.id, status: 'offline' }],
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

  test('keeps multipart file bytes that contain the request boundary text', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'agentbean-next-artifacts-multipart-boundary-'));
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
      username: 'boundary-shaw',
      password: 'secret',
      teamName: 'AgentBean',
    }) as {
      ok: true;
      token: string;
      currentTeam: { id: string };
      defaultChannel: { id: string };
    };
    const boundary = 'agentbean-fixed-boundary';
    const fileContent = `before --${boundary} inside file after\n`;
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="token"\r\n\r\n${owner.token}\r\n`),
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="channelId"\r\n\r\n${owner.defaultChannel.id}\r\n`),
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="boundary.md"\r\nContent-Type: text/markdown\r\n\r\n`),
      Buffer.from(fileContent),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);

    const upload = await fetch(`${server.baseUrl}/api/teams/${owner.currentTeam.id}/artifacts/upload`, {
      method: 'POST',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      body,
    });
    expect(upload.status).toBe(201);
    const uploadJson = await upload.json() as {
      ok: true;
      artifact: { id: string; previewUrl: string };
    };

    const preview = await fetch(`${server.baseUrl}${uploadJson.artifact.previewUrl}?token=${encodeURIComponent(owner.token)}`);
    expect(preview.status).toBe(200);
    await expect(preview.text()).resolves.toBe(fileContent);
  });

  test('encodes artifact download filenames from stored artifact metadata', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'agentbean-next-artifact-filename-'));
    writeFileSync(join(dataDir, 'stored.txt'), 'stored content');
    const app = {
      whoami: vi.fn(async () => makeSuccess({ user: { id: 'user-1', username: 'shaw', createdAt: 1 } })),
      getArtifactFile: vi.fn(async () =>
        makeSuccess({
          artifact: {
            id: 'artifact-1',
            teamId: 'team-1',
            channelId: 'channel-1',
            filename: '报告 "Q2"\n✅.txt',
            mimeType: 'text/plain',
            sizeBytes: 14,
            createdAt: 1,
          },
          storagePath: 'stored.txt',
        }),
      ),
    } as unknown as ServerNextUseCases;
    const server = await startServerNextDevServer({
      app,
      Server,
      config: { host: '127.0.0.1', port: 0, storage: 'memory', dataDir, sessionSecret: 'test-secret' },
    });
    cleanups.push(() => server.close());

    const response = await fetch(`${server.baseUrl}/api/teams/team-1/artifacts/artifact-1/download?token=token-1`);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-disposition')).toBe(
      `attachment; filename="Q2.txt"; filename*=UTF-8''${encodeURIComponent('报告 "Q2"\n✅.txt')}`,
    );
    await expect(response.text()).resolves.toBe('stored content');
  });

  test('forces active artifact preview content to download', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'agentbean-next-artifact-active-preview-'));
    writeFileSync(join(dataDir, 'active.html'), '<script>localStorage.token</script>');
    const app = {
      whoami: vi.fn(async () => makeSuccess({ user: { id: 'user-1', username: 'shaw', createdAt: 1 } })),
      getArtifactFile: vi.fn(async () =>
        makeSuccess({
          artifact: {
            id: 'artifact-1',
            teamId: 'team-1',
            channelId: 'channel-1',
            filename: 'active.html',
            mimeType: 'text/html',
            sizeBytes: 35,
            createdAt: 1,
          },
          storagePath: 'active.html',
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

    expect(response.status).toBe(200);
    expect(response.headers.get('content-disposition')).toContain('attachment');
    expect(response.headers.get('content-disposition')).toContain('active.html');
    await expect(response.text()).resolves.toBe('<script>localStorage.token</script>');
  });

  test('serves custom agent env only with bearer device credentials', async () => {
    const app = {
      getAgentEnvForDevice: vi.fn(async () => makeSuccess({ env: { OPENAI_API_KEY: 'secret-value' } })),
    } as unknown as ServerNextUseCases;
    const server = await startServerNextDevServer({
      app,
      Server,
      config: { host: '127.0.0.1', port: 0, storage: 'memory', dataDir: '.agentbean-next-test', sessionSecret: 'test-secret' },
    });
    cleanups.push(() => server.close());

    const queryToken = await fetch(`${server.baseUrl}/api/teams/team-1/agents/agent-1/env?token=device-token`);
    expect(queryToken.status).toBe(401);
    expect(app.getAgentEnvForDevice).not.toHaveBeenCalled();

    const bearer = await fetch(`${server.baseUrl}/api/teams/team-1/agents/agent-1/env`, {
      headers: { Authorization: 'Bearer device-token' },
    });
    expect(bearer.status).toBe(200);
    await expect(bearer.json()).resolves.toEqual({
      ok: true,
      env: { OPENAI_API_KEY: 'secret-value' },
    });
    expect(app.getAgentEnvForDevice).toHaveBeenCalledWith({
      token: 'device-token',
      teamId: 'team-1',
      agentId: 'agent-1',
    });
  });

  test('accepts bearer device credentials for artifact upload and download', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'agentbean-next-device-artifacts-'));
    writeFileSync(join(dataDir, 'stored.txt'), 'stored content');
    const app = {
      uploadArtifactForDevice: vi.fn(async (input) =>
        makeSuccess({
          artifact: {
            id: 'artifact-1',
            teamId: input.teamId,
            channelId: input.channelId,
            filename: input.filename,
            mimeType: input.mimeType,
            sizeBytes: input.sizeBytes,
            storagePath: input.storagePath,
            relativePath: input.relativePath,
            pathKind: 'upload',
            sha256: input.sha256,
            createdAt: 1,
          },
        }),
      ),
      getArtifactFileForDevice: vi.fn(async () =>
        makeSuccess({
          artifact: {
            id: 'artifact-1',
            teamId: 'team-1',
            channelId: 'channel-1',
            filename: 'stored.txt',
            mimeType: 'text/plain',
            sizeBytes: 14,
            storagePath: 'stored.txt',
            createdAt: 1,
          },
          storagePath: 'stored.txt',
        }),
      ),
    } as unknown as ServerNextUseCases;
    const server = await startServerNextDevServer({
      app,
      Server,
      config: { host: '127.0.0.1', port: 0, storage: 'memory', dataDir, sessionSecret: 'test-secret' },
    });
    cleanups.push(() => server.close());

    const form = new FormData();
    form.append('channelId', 'channel-1');
    form.append('file', new Blob(['device artifact'], { type: 'text/plain' }), 'device.txt');
    const upload = await fetch(`${server.baseUrl}/api/teams/team-1/artifacts/upload`, {
      method: 'POST',
      headers: { Authorization: 'Bearer abn_device.test' },
      body: form,
    });
    expect(upload.status).toBe(201);
    expect(app.uploadArtifactForDevice).toHaveBeenCalledWith(expect.objectContaining({
      token: 'abn_device.test',
      teamId: 'team-1',
      channelId: 'channel-1',
      filename: 'device.txt',
      mimeType: 'text/plain',
    }));

    const download = await fetch(`${server.baseUrl}/api/teams/team-1/artifacts/artifact-1/download`, {
      headers: { Authorization: 'Bearer abn_device.test' },
    });
    expect(download.status).toBe(200);
    await expect(download.text()).resolves.toBe('stored content');
    expect(app.getArtifactFileForDevice).toHaveBeenCalledWith({
      token: 'abn_device.test',
      teamId: 'team-1',
      artifactId: 'artifact-1',
    });
  });

  test('rejects oversized artifact upload bodies before authentication', async () => {
    const app = {
      whoami: vi.fn(async () => makeSuccess({ user: { id: 'user-1', username: 'shaw', createdAt: 1 } })),
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
    });
    cleanups.push(() => server.close());

    const response = await fetch(`${server.baseUrl}/api/teams/team-1/artifacts/upload`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: 'token-1', contentBase64: 'a'.repeat(10 * 1024 * 1024 + 1) }),
    });

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toMatchObject({ ok: false, error: 'PAYLOAD_TOO_LARGE' });
    expect(app.whoami).not.toHaveBeenCalled();
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
            sourceMessageId: 'source-message-1',
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
      workspaceRun: { id: 'run-1', cwd: '/Users/shaw/AgentBean', sourceMessageId: 'source-message-1' },
      artifacts: [{ id: 'artifact-1', relativePath: 'outputs/result.md' }],
    });
    expect(app.getWorkspaceRunDetail).toHaveBeenCalledWith({
      userId: 'user-1',
      teamId: 'team-1',
      runId: 'run-1',
    });
  });

  test('translates unexpected workspace run detail errors into redacted JSON 500 responses', async () => {
    const app = {
      whoami: vi.fn(async () => makeSuccess({ user: { id: 'user-1', username: 'shaw', createdAt: 1 } })),
      getWorkspaceRunDetail: vi.fn(async () => {
        throw new Error('SQLite workspace artifact row could not be mapped');
      }),
    } as unknown as ServerNextUseCases;
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const server = await startServerNextDevServer({
      app,
      Server,
      config: { host: '127.0.0.1', port: 0, storage: 'memory', dataDir: '.agentbean-next-test', sessionSecret: 'test-secret' },
    });
    cleanups.push(() => server.close());

    const response = await fetch(`${server.baseUrl}/api/teams/team-1/workspace-runs/run-1?token=token-1`);

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: 'INTERNAL_ERROR',
      message: 'Internal server error',
    });
    expect(consoleError).toHaveBeenCalledWith(
      '[server-next] HTTP request threw:',
      expect.stringContaining('SQLite workspace artifact row could not be mapped'),
    );
    consoleError.mockRestore();
  });

  test('translates unexpected workspace run log errors into redacted JSON 500 responses', async () => {
    const app = {
      whoami: vi.fn(async () => makeSuccess({ user: { id: 'user-1', username: 'shaw', createdAt: 1 } })),
      getWorkspaceRunLogFile: vi.fn(async () => {
        throw new Error('log storage path leaked');
      }),
    } as unknown as ServerNextUseCases;
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const server = await startServerNextDevServer({
      app,
      Server,
      config: { host: '127.0.0.1', port: 0, storage: 'memory', dataDir: '.agentbean-next-test', sessionSecret: 'test-secret' },
    });
    cleanups.push(() => server.close());

    const response = await fetch(`${server.baseUrl}/api/teams/team-1/workspace-runs/run-1/log?token=token-1`);

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: 'INTERNAL_ERROR',
      message: 'Internal server error',
    });
    expect(consoleError).toHaveBeenCalledWith(
      '[server-next] HTTP request threw:',
      expect.stringContaining('log storage path leaked'),
    );
    consoleError.mockRestore();
  });

  test('serves bounded workspace run log tail and search over HTTP', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'agentbean-next-workspace-log-'));
    writeFileSync(join(dataDir, 'workspace-run.log'), [
      'starting workspace run',
      'install dependencies',
      'finished workspace run',
      'done',
    ].join('\n'));
    const app = {
      whoami: vi.fn(async () => makeSuccess({ user: { id: 'user-1', username: 'shaw', createdAt: 1 } })),
      getWorkspaceRunLogFile: vi.fn(async () =>
        makeSuccess({
          artifact: {
            id: 'log-1',
            teamId: 'team-1',
            channelId: 'channel-1',
            dispatchId: 'dispatch-1',
            workspaceRunId: 'run-1',
            filename: 'workspace-run.log',
            mimeType: 'text/plain',
            sizeBytes: 78,
            relativePath: 'logs/workspace-run.log',
            pathKind: 'workspace',
            createdAt: 2,
          },
          storagePath: 'workspace-run.log',
        }),
      ),
    } as unknown as ServerNextUseCases;
    const server = await startServerNextDevServer({
      app,
      Server,
      config: { host: '127.0.0.1', port: 0, storage: 'memory', dataDir, sessionSecret: 'test-secret' },
    });
    cleanups.push(() => server.close());

    const tail = await fetch(`${server.baseUrl}/api/teams/team-1/workspace-runs/run-1/log?token=token-1&tailLines=2`);
    expect(tail.status).toBe(200);
    await expect(tail.json()).resolves.toMatchObject({
      ok: true,
      teamId: 'team-1',
      runId: 'run-1',
      mode: 'tail',
      text: 'finished workspace run\ndone',
      returnedLines: 2,
      truncated: true,
      artifact: {
        id: 'log-1',
        previewUrl: '/api/teams/team-1/artifacts/log-1/preview',
        downloadUrl: '/api/teams/team-1/artifacts/log-1/download',
      },
    });

    const search = await fetch(`${server.baseUrl}/api/teams/team-1/workspace-runs/run-1/log?token=token-1&query=finished`);
    expect(search.status).toBe(200);
    await expect(search.json()).resolves.toMatchObject({
      ok: true,
      mode: 'search',
      text: 'finished workspace run',
      totalLines: 4,
      returnedLines: 1,
      matchedLines: 1,
      query: 'finished',
      truncated: false,
    });
    expect(app.getWorkspaceRunLogFile).toHaveBeenCalledWith({
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

  test('forwards agentId, deviceId and status query filters to listTeamWorkspaceRuns', async () => {
    const app = {
      whoami: vi.fn(async () => makeSuccess({ user: { id: 'user-1', username: 'shaw', createdAt: 1 } })),
      listTeamWorkspaceRuns: vi.fn(async () => makeSuccess({ runs: [] })),
    } as unknown as ServerNextUseCases;
    const server = await startServerNextDevServer({
      app,
      Server,
      config: { host: '127.0.0.1', port: 0, storage: 'memory', dataDir: '.agentbean-next-test', sessionSecret: 'test-secret' },
    });
    cleanups.push(() => server.close());

    const response = await fetch(
      `${server.baseUrl}/api/teams/team-1/workspace-runs?token=token-1&agentId=agent-9&deviceId=device-9&status=failed`,
    );

    expect(response.status).toBe(200);
    expect(app.listTeamWorkspaceRuns).toHaveBeenCalledWith({
      userId: 'user-1',
      teamId: 'team-1',
      agentId: 'agent-9',
      deviceId: 'device-9',
      status: 'failed',
    });
  });

  test('ignores blank team workspace run query filters', async () => {
    const app = {
      whoami: vi.fn(async () => makeSuccess({ user: { id: 'user-1', username: 'shaw', createdAt: 1 } })),
      listTeamWorkspaceRuns: vi.fn(async () => makeSuccess({ runs: [] })),
    } as unknown as ServerNextUseCases;
    const server = await startServerNextDevServer({
      app,
      Server,
      config: { host: '127.0.0.1', port: 0, storage: 'memory', dataDir: '.agentbean-next-test', sessionSecret: 'test-secret' },
    });
    cleanups.push(() => server.close());

    const response = await fetch(
      `${server.baseUrl}/api/teams/team-1/workspace-runs?token=token-1&agentId=&deviceId=%20&status=`,
    );

    expect(response.status).toBe(200);
    expect(app.listTeamWorkspaceRuns).toHaveBeenCalledWith({
      userId: 'user-1',
      teamId: 'team-1',
      agentId: undefined,
      deviceId: undefined,
      status: undefined,
    });
  });

  test('rejects invalid team workspace run status query filters', async () => {
    const app = {
      whoami: vi.fn(async () => makeSuccess({ user: { id: 'user-1', username: 'shaw', createdAt: 1 } })),
      listTeamWorkspaceRuns: vi.fn(async () => makeSuccess({ runs: [] })),
    } as unknown as ServerNextUseCases;
    const server = await startServerNextDevServer({
      app,
      Server,
      config: { host: '127.0.0.1', port: 0, storage: 'memory', dataDir: '.agentbean-next-test', sessionSecret: 'test-secret' },
    });
    cleanups.push(() => server.close());

    const response = await fetch(
      `${server.baseUrl}/api/teams/team-1/workspace-runs?token=token-1&status=done`,
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: 'BAD_REQUEST',
      message: 'Invalid workspace run status',
    });
    expect(app.listTeamWorkspaceRuns).not.toHaveBeenCalled();
  });

  test('forwards cursor and pageSize query to listTeamWorkspaceRuns', async () => {
    const app = {
      whoami: vi.fn(async () => makeSuccess({ user: { id: 'user-1', username: 'shaw', createdAt: 1 } })),
      listTeamWorkspaceRuns: vi.fn(async () => makeSuccess({ runs: [], nextCursor: 'next-token' })),
    } as unknown as ServerNextUseCases;
    const server = await startServerNextDevServer({
      app,
      Server,
      config: { host: '127.0.0.1', port: 0, storage: 'memory', dataDir: '.agentbean-next-test', sessionSecret: 'test-secret' },
    });
    cleanups.push(() => server.close());

    const response = await fetch(
      `${server.baseUrl}/api/teams/team-1/workspace-runs?token=token-1&cursor=abc&pageSize=15`,
    );

    expect(response.status).toBe(200);
    expect(app.listTeamWorkspaceRuns).toHaveBeenCalledWith({
      userId: 'user-1',
      teamId: 'team-1',
      agentId: undefined,
      deviceId: undefined,
      status: undefined,
      cursor: 'abc',
      pageSize: 15,
    });
    await expect(response.json()).resolves.toMatchObject({ ok: true, nextCursor: 'next-token' });
  });

  test('returns 400 when listTeamWorkspaceRuns rejects an invalid cursor', async () => {
    const app = {
      whoami: vi.fn(async () => makeSuccess({ user: { id: 'user-1', username: 'shaw', createdAt: 1 } })),
      listTeamWorkspaceRuns: vi.fn(async () => ({ ok: false, error: 'BAD_REQUEST', message: 'Invalid workspace run cursor' })),
    } as unknown as ServerNextUseCases;
    const server = await startServerNextDevServer({
      app,
      Server,
      config: { host: '127.0.0.1', port: 0, storage: 'memory', dataDir: '.agentbean-next-test', sessionSecret: 'test-secret' },
    });
    cleanups.push(() => server.close());

    const response = await fetch(
      `${server.baseUrl}/api/teams/team-1/workspace-runs?token=token-1&cursor=bad`,
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ ok: false, error: 'BAD_REQUEST' });
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

  test('starts the coordination consumer when durable-job ingestion is enabled', async () => {
    const runCoordinationCycle = vi.fn(async () => ({ processed: 0, outcomes: [] }));
    const app = { runCoordinationCycle } as unknown as ServerNextUseCases;
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
      messageIngestionMode: 'durable-job',
      coordination: { intervalMs: 5, limit: 7 },
      dispatchTimeout: { timeoutMs: 0, intervalMs: 0 },
    });
    cleanups.push(() => server.close());

    await eventually(() => {
      expect(runCoordinationCycle).toHaveBeenCalledWith({ limit: 7 });
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
