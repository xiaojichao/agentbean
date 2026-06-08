import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { createServer, type Server as HttpServer } from 'node:http';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServerNextUseCases } from './application/usecases.js';
import { createInMemoryRepositories } from './infra/memory/repositories.js';
import {
  applyGlobalMigrations,
  applyTeamMigrations,
  createSqliteRepositories,
  type SqliteDatabase,
} from './infra/sqlite/repositories.js';
import { attachServerNextNamespaces, type ServerNextRealtime, type SocketServerLike } from './transport/socket-server.js';
import type { ServerNextUseCases } from './application/usecases.js';

type SocketIoServerConstructor = new (server: HttpServer, options?: Record<string, unknown>) => SocketServerLike & {
  close(callback?: () => void): void;
};

export interface ServerNextDevConfig {
  host: string;
  port: number;
  storage: 'memory' | 'sqlite';
  dataDir: string;
  sessionSecret: string;
}

export interface ParseServerNextDevConfigInput {
  argv?: string[];
  env?: NodeJS.ProcessEnv;
}

export interface StartServerNextDevServerInput {
  app?: ServerNextUseCases;
  config?: ServerNextDevConfig;
  Server?: SocketIoServerConstructor;
  Database?: BetterSqlite3Constructor;
  dispatchTimeout?: DispatchTimeoutSchedulerConfig;
}

export interface ServerNextDevServerHandle {
  host: string;
  port: number;
  baseUrl: string;
  httpServer: HttpServer;
  ioServer: InstanceType<SocketIoServerConstructor>;
  close(): Promise<void>;
}

type BetterSqlite3Constructor = new (filename: string) => SqliteDatabase & { close(): void };

export interface DispatchTimeoutSchedulerConfig {
  timeoutMs: number;
  intervalMs: number;
}

export function parseServerNextDevConfig(input: ParseServerNextDevConfigInput = {}): ServerNextDevConfig {
  const argv = input.argv ?? process.argv.slice(2);
  const env = input.env ?? process.env;
  const args = parseArgs(argv);
  const host = args.host ?? env.AGENTBEAN_NEXT_HOST ?? (env.PORT ? '0.0.0.0' : '127.0.0.1');
  const port = Number(args.port ?? env.AGENTBEAN_NEXT_PORT ?? env.PORT ?? 4100);
  const storage = args.storage ?? env.AGENTBEAN_NEXT_STORAGE ?? (env.PORT ? 'sqlite' : 'memory');
  const configuredDataDir = args['data-dir'] ?? env.AGENTBEAN_NEXT_DATA_DIR;
  const hasExplicitDataDir = configuredDataDir !== undefined && configuredDataDir.length > 0;
  const dataDir = hasExplicitDataDir ? configuredDataDir : join(process.cwd(), '.agentbean-next');
  const sessionSecret = args['session-secret'] ?? env.AGENTBEAN_NEXT_SESSION_SECRET ?? '';
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error('AGENTBEAN_NEXT_PORT or --port must be an integer between 0 and 65535');
  }
  if (storage !== 'memory' && storage !== 'sqlite') {
    throw new Error('AGENTBEAN_NEXT_STORAGE or --storage must be memory or sqlite');
  }
  if (env.PORT && !sessionSecret) {
    throw new Error('AGENTBEAN_NEXT_SESSION_SECRET or --session-secret is required when PORT is set');
  }
  if (env.PORT && storage === 'sqlite' && !hasExplicitDataDir) {
    throw new Error('AGENTBEAN_NEXT_DATA_DIR or --data-dir is required when PORT uses sqlite storage');
  }
  return { host, port, storage, dataDir, sessionSecret: sessionSecret || 'agentbean-next-dev-session-secret' };
}

export async function startServerNextDevServer(
  input: StartServerNextDevServerInput = {},
): Promise<ServerNextDevServerHandle> {
  const config = input.config ?? parseServerNextDevConfig();
  const appWithCleanup = input.app
    ? { app: input.app, close: async () => undefined }
    : createDefaultApp(config, input.Database);
  const app = appWithCleanup.app;
  const Server = input.Server ?? loadSocketIoServer();
  const httpServer = createServer((request, response) => {
    if (request.url === '/' || request.url === '/preview') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(readPreviewHtml());
      return;
    }
    if (request.url === '/healthz') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: true, service: 'agentbean-next-server' }));
      return;
    }
    response.writeHead(404, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ ok: false, error: 'NOT_FOUND' }));
  });
  const ioServer = new Server(httpServer, { cors: { origin: '*' } });
  const realtime = attachServerNextNamespaces(ioServer, app);
  const dispatchTimeoutInterval = startDispatchTimeoutScheduler(
    app,
    realtime,
    input.dispatchTimeout ?? { timeoutMs: 5 * 60 * 1000, intervalMs: 5000 },
  );

  await new Promise<void>((resolve) => {
    httpServer.listen(config.port, config.host, () => resolve());
  });
  const address = httpServer.address();
  const port = typeof address === 'object' && address ? address.port : config.port;
  return {
    host: config.host,
    port,
    baseUrl: `http://${config.host}:${port}`,
    httpServer,
    ioServer,
    async close() {
      if (dispatchTimeoutInterval) {
        clearInterval(dispatchTimeoutInterval);
      }
      await new Promise<void>((resolve) => ioServer.close(() => resolve()));
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
      await appWithCleanup.close();
    },
  };
}

function startDispatchTimeoutScheduler(
  app: ServerNextUseCases,
  realtime: ServerNextRealtime,
  config: DispatchTimeoutSchedulerConfig,
): ReturnType<typeof setInterval> | null {
  if (config.intervalMs <= 0 || config.timeoutMs <= 0) {
    return null;
  }
  return setInterval(async () => {
    const result = await app.failTimedOutDispatches({ olderThan: Date.now() - config.timeoutMs });
    if (!result.ok) {
      return;
    }
    for (const dispatch of result.dispatches) {
      realtime.emitDispatchStatus(dispatch);
    }
  }, config.intervalMs);
}

function readPreviewHtml(): string {
  const candidates = [
    new URL('../../../../../web-next/preview/index.html', import.meta.url),
    new URL('../../web-next/preview/index.html', import.meta.url),
    pathToFileURL(join(process.cwd(), 'apps/web-next/preview/index.html')),
  ];
  for (const candidate of candidates) {
    try {
      const path = candidate.pathname;
      if (existsSync(path)) {
        return readFileSync(path, 'utf8');
      }
    } catch {
      // Try the next known repository layout.
    }
  }
  throw new Error('web-next preview page not found');
}

function createDefaultApp(
  config: ServerNextDevConfig,
  Database: BetterSqlite3Constructor | undefined,
): { app: ServerNextUseCases; close(): Promise<void> } {
  if (config.storage === 'memory') {
    return {
      app: createServerNextUseCases({
        repositories: createInMemoryRepositories(),
        clock: { now: () => Date.now() },
        ids: {
          nextId: () => randomUUID(),
        },
        sessionSecret: config.sessionSecret,
      }),
      close: async () => undefined,
    };
  }

  mkdirSync(config.dataDir, { recursive: true });
  const Sqlite = Database ?? loadBetterSqlite3();
  const globalDb = new Sqlite(join(config.dataDir, 'global.sqlite'));
  const teamDb = new Sqlite(join(config.dataDir, 'team.sqlite'));
  applyGlobalMigrations(globalDb);
  applyTeamMigrations(teamDb);
  return {
    app: createServerNextUseCases({
      repositories: createSqliteRepositories({ globalDb, teamDb }),
      clock: { now: () => Date.now() },
      ids: {
        nextId: () => randomUUID(),
      },
      sessionSecret: config.sessionSecret,
    }),
    async close() {
      globalDb.close();
      teamDb.close();
    },
  };
}

export async function runServerNextDevServer(config = parseServerNextDevConfig()): Promise<ServerNextDevServerHandle> {
  const handle = await startServerNextDevServer({ config });
  console.log(`AgentBean Next server listening at ${handle.baseUrl}`);
  return handle;
}

function loadSocketIoServer(): SocketIoServerConstructor {
  const requireUrls = [
    new URL('../../../../../server/package.json', import.meta.url),
    new URL('../../server/package.json', import.meta.url),
    pathToFileURL(join(process.cwd(), 'apps/server/package.json')),
  ];
  for (const requireUrl of requireUrls) {
    try {
      const loaded = createRequire(requireUrl)('socket.io') as { Server: SocketIoServerConstructor };
      return loaded.Server;
    } catch {
      // Try the next known repository layout.
    }
  }
  throw new Error('socket.io is not installed; run npm ci in apps/server or provide a workspace install');
}

function loadBetterSqlite3(): BetterSqlite3Constructor {
  const requireUrls = [
    new URL('../../../../../server/package.json', import.meta.url),
    new URL('../../server/package.json', import.meta.url),
    pathToFileURL(join(process.cwd(), 'apps/server/package.json')),
  ];
  for (const requireUrl of requireUrls) {
    try {
      const Candidate = createRequire(requireUrl)('better-sqlite3') as BetterSqlite3Constructor;
      const db = new Candidate(':memory:');
      db.close();
      return Candidate;
    } catch {
      // Try the next installed copy; native modules are ABI-specific.
    }
  }
  throw new Error('better-sqlite3 is not installed for this Node.js runtime; run npm ci in apps/server');
}

function parseArgs(argv: string[]): Record<string, string> {
  const parsed: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg?.startsWith('--')) {
      continue;
    }
    const key = arg.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) {
      throw new Error(`Missing value for --${key}`);
    }
    parsed[key] = value;
    index += 1;
  }
  return parsed;
}
