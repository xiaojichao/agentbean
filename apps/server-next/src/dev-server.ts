import { closeSync, createReadStream, existsSync, mkdirSync, openSync, readFileSync, readSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http';
import { createRequire } from 'node:module';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { createServerNextUseCases, type ArtifactContentStore } from './application/usecases.js';
import type { ServerNextRepositories } from './application/repositories.js';
import { createCapsuleInjectionValidator } from './application/capsule-injection-validator.js';
import { createServerCapsuleRuntimeContextService } from './application/server-capsule-runtime-context-service.js';
import {
  createServerMemorySearchPermissions,
  createServerMemoryWritePermissions,
  createServerMemoryCandidatePermissions,
  CURRENT_MEMORY_POLICY_VERSION,
} from './application/server-memory-permissions.js';
import { createDeviceWorkerScheduler, type DeviceWorkerScheduler } from './application/management/device-worker-scheduler.js';
import { createManagementKernel } from './application/management/management-kernel.js';
import { createManagementToolExecutor, createPhase1ManagementToolHandlers, createPhase2CollaborationToolHandlers, createPhase2InvocationToolHandlers, createPhase2ManagementToolHandlers, createPhase3ManagementToolHandlers } from './application/management/management-tool-executor.js';
import { createSubtaskAcceptanceService } from './application/management/subtask-acceptance-service.js';
import { createTaskCoordinationKernel } from './application/management/task-coordination-kernel.js';
import { createManagementRouter } from './application/management/management-router.js';
import { createCollaborativeMemorySearchService } from './application/collaborative-memory-search-service.js';
import { createMemoryCapsuleService } from './application/memory-capsule-service.js';
import { createMemoryCandidateService } from './application/memory-candidate-service.js';
import { createCollaborativeMemoryService } from './application/collaborative-memory-service.js';
import { createTaskClaimBroker, type TaskClaimBroker } from './application/management/task-claim-broker.js';
import { createInMemoryRepositories } from './infra/memory/repositories.js';
import {
  applyGlobalMigrations,
  applyTeamMigrations,
  cleanupOrphanedChannelMembers,
  createSqliteRepositories,
  type SqliteDatabase,
} from './infra/sqlite/repositories.js';
import { attachServerNextNamespaces, type ServerNextRealtime, type SocketServerLike } from './transport/socket-server.js';
import { startDaemonVersionRefresh } from './daemon-version.js';
import { makeFailure, type ArtifactDto, type WorkspaceRunStatus } from '../../../packages/contracts/src/index.js';
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
  webEntry?: 'preview' | 'app';
}

export interface ParseServerNextDevConfigInput {
  argv?: string[];
  env?: NodeJS.ProcessEnv;
}

export interface StartServerNextDevServerInput {
  app?: ServerNextUseCases;
  managementWorkerScheduler?: DeviceWorkerScheduler;
  taskClaimBroker?: TaskClaimBroker;
  config?: ServerNextDevConfig;
  Server?: SocketIoServerConstructor;
  Database?: BetterSqlite3Constructor;
  dispatchTimeout?: DispatchTimeoutSchedulerConfig;
  webApp?: WebAppHandler;
}

export interface ServerNextDevServerHandle {
  host: string;
  port: number;
  baseUrl: string;
  httpServer: HttpServer;
  ioServer: InstanceType<SocketIoServerConstructor>;
  close(): Promise<void>;
}

interface AppWithCleanup {
  app: ServerNextUseCases;
  managementWorkerScheduler?: DeviceWorkerScheduler;
  taskClaimBroker?: TaskClaimBroker;
  bindManagementDispatchEmitter?(emit: (dispatchId: string) => Promise<void>): void;
  bindTaskClaimEmitter?(emit: (taskId: string) => Promise<void>): void;
  reconcileDisconnectedDevicesOnStart: boolean;
  close(): Promise<void>;
}

interface WebAppHandler {
  handle(request: IncomingMessage, response: ServerResponse): Promise<void>;
  close(): Promise<void>;
}

type NextAppFactory = (options: {
  dev: boolean;
  dir: string;
  hostname: string;
  port: number;
}) => {
  prepare(): Promise<void>;
  getRequestHandler(): (request: IncomingMessage, response: ServerResponse) => Promise<void>;
  close(): Promise<void>;
};

type BetterSqlite3Constructor = new (filename: string) => SqliteDatabase & { close(): void };
type CorsOrigin = string | string[] | false;

const INTERNAL_HTTP_ERROR_MESSAGE = 'Internal server error';
const MAX_ARTIFACT_UPLOAD_BODY_BYTES = 10 * 1024 * 1024;
const DEFAULT_WORKSPACE_LOG_TAIL_LINES = 200;
const MAX_WORKSPACE_LOG_RESPONSE_BYTES = 64 * 1024;
const ACTIVE_PREVIEW_MIME_TYPES = new Set([
  'application/ecmascript',
  'application/javascript',
  'application/xhtml+xml',
  'image/svg+xml',
  'text/ecmascript',
  'text/html',
  'text/javascript',
]);
const WORKSPACE_RUN_STATUSES = new Set<WorkspaceRunStatus>([
  'running',
  'succeeded',
  'failed',
  'cancelled',
]);
const DEFAULT_PRODUCTION_WEB_ORIGINS = ['https://agentbean.dev', 'https://www.agentbean.dev'];
const DEFAULT_LOCAL_WEB_ORIGINS = ['http://localhost:3100', 'http://localhost:4101'];

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
  const webEntry = args['web-entry'] ?? env.AGENTBEAN_NEXT_WEB_ENTRY ?? (env.PORT ? 'app' : 'preview');
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
  if (webEntry !== 'preview' && webEntry !== 'app') {
    throw new Error('AGENTBEAN_NEXT_WEB_ENTRY or --web-entry must be preview or app');
  }
  if (env.PORT && !sessionSecret) {
    throw new Error('AGENTBEAN_NEXT_SESSION_SECRET or --session-secret is required when PORT is set');
  }
  if (env.PORT && storage === 'sqlite' && !hasExplicitDataDir) {
    throw new Error('AGENTBEAN_NEXT_DATA_DIR or --data-dir is required when PORT uses sqlite storage');
  }
  return { host, port, storage, dataDir, sessionSecret: sessionSecret || 'agentbean-next-dev-session-secret', webEntry };
}

export async function startServerNextDevServer(
  input: StartServerNextDevServerInput = {},
): Promise<ServerNextDevServerHandle> {
  const config = input.config ?? parseServerNextDevConfig();
  const appWithCleanup = input.app
    ? { app: input.app, managementWorkerScheduler: input.managementWorkerScheduler, taskClaimBroker: input.taskClaimBroker, reconcileDisconnectedDevicesOnStart: false, close: async () => undefined }
    : createDefaultApp(config, input.Database);
  const app = appWithCleanup.app;
  if (appWithCleanup.reconcileDisconnectedDevicesOnStart) {
    await app.reconcileDisconnectedDevices({ timestamp: Date.now() });
  }
  const Server = input.Server ?? loadSocketIoServer();
  const webEntry = config.webEntry ?? 'preview';
  const webApp = webEntry === 'app' ? input.webApp ?? await createWebAppHandler(config) : null;
  const restCorsOrigin = resolveRestCorsOrigin();
  const httpServer = createServer(async (request, response) => {
    try {
      if (handleRestCors(request, response, restCorsOrigin)) {
        return;
      }
      const url = new URL(request.url ?? '/', 'http://agentbean-next.local');
      if (url.pathname === '/preview' || (url.pathname === '/' && !webApp)) {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        response.end(readPreviewHtml());
        return;
      }
      if (url.pathname === '/healthz') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ ok: true, service: 'agentbean-next-server' }));
        return;
      }
      if (await handleAgentWorkspaceHttp({ app, config, request, response, url })) {
        return;
      }
      if (await handleTeamWorkspaceRunsHttp({ app, config, request, response, url })) {
        return;
      }
      if (await handleWorkspaceRunLogHttp({ app, config, request, response, url })) {
        return;
      }
      if (await handleWorkspaceRunHttp({ app, config, request, response, url })) {
        return;
      }
      if (await handleArtifactHttp({ app, config, request, response, url })) {
        return;
      }
      if (await handleAgentEnvHttp({ app, config, request, response, url })) {
        return;
      }
      if (webApp) {
        await webApp.handle(request, response);
        return;
      }
      response.writeHead(404, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: false, error: 'NOT_FOUND' }));
    } catch (error) {
      writeInternalHttpError(response, error);
    }
  });
  const ioServer = new Server(httpServer, { cors: { origin: '*' } });
  const realtime = attachServerNextNamespaces(ioServer, app, {
    managementWorkerScheduler: input.managementWorkerScheduler ?? appWithCleanup.managementWorkerScheduler,
    taskClaimBroker: input.taskClaimBroker ?? appWithCleanup.taskClaimBroker,
  });
  appWithCleanup.bindManagementDispatchEmitter?.((dispatchId) => realtime.dispatchRequest(dispatchId));
  appWithCleanup.bindTaskClaimEmitter?.(async (taskId) => {
    await realtime.offerTaskClaims(taskId);
  });
  const dispatchTimeoutInterval = startDispatchTimeoutScheduler(
    app,
    realtime,
    input.dispatchTimeout ?? { timeoutMs: 5 * 60 * 1000, intervalMs: 5000 },
  );

  await new Promise<void>((resolve) => {
    httpServer.listen(config.port, config.host, () => resolve());
  });
  const stopVersionRefresh = startDaemonVersionRefresh();
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
      stopVersionRefresh();
      await webApp?.close();
      await new Promise<void>((resolve) => ioServer.close(() => resolve()));
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
      await appWithCleanup.close();
    },
  };
}

function parseOriginList(value?: string): string[] {
  return (value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function withCanonicalHostVariants(origins: string[]): string[] {
  const expanded = new Set(origins);
  for (const origin of origins) {
    try {
      const url = new URL(origin);
      expanded.add(url.origin);
      if (url.hostname.startsWith('www.')) {
        url.hostname = url.hostname.slice(4);
        expanded.add(url.origin);
      } else {
        url.hostname = `www.${url.hostname}`;
        expanded.add(url.origin);
      }
    } catch {
      // Non-URL CORS values such as "*" are preserved as-is.
    }
  }
  return [...expanded];
}

function corsOriginFromList(origins: string[]): CorsOrigin {
  if (origins.length === 0) return false;
  return origins.length === 1 ? origins[0]! : origins;
}

function resolveRestCorsOrigin(env: NodeJS.ProcessEnv = process.env): CorsOrigin {
  const configured = withCanonicalHostVariants(parseOriginList(env.CORS_ORIGIN));
  if (configured.length > 0) return corsOriginFromList(configured);

  const webOrigins = withCanonicalHostVariants(parseOriginList(env.WEB_URL));
  if (webOrigins.length > 0) return corsOriginFromList(webOrigins);

  if (env.PORT) return DEFAULT_PRODUCTION_WEB_ORIGINS;
  return DEFAULT_LOCAL_WEB_ORIGINS;
}

function resolveRequestCorsOrigin(origin: CorsOrigin, requestOrigin?: string): string | undefined {
  if (!origin) return undefined;
  if (origin === '*') return '*';
  if (Array.isArray(origin)) {
    if (origin.includes('*')) return '*';
    return requestOrigin && origin.includes(requestOrigin) ? requestOrigin : undefined;
  }
  return origin;
}

function handleRestCors(request: IncomingMessage, response: ServerResponse, origin: CorsOrigin): boolean {
  const allowedOrigin = resolveRequestCorsOrigin(origin, request.headers.origin);
  if (allowedOrigin) {
    response.setHeader('Access-Control-Allow-Origin', allowedOrigin);
    response.setHeader('Vary', 'Origin');
    response.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  }
  if (request.method === 'OPTIONS') {
    response.writeHead(204);
    response.end();
    return true;
  }
  return false;
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
      await realtime.refreshAgents(dispatch.teamId);
    }
  }, config.intervalMs);
}

interface ArtifactHttpInput {
  app: ServerNextUseCases;
  config: ServerNextDevConfig;
  request: IncomingMessage;
  response: ServerResponse;
  url: URL;
}

async function handleAgentWorkspaceHttp(input: ArtifactHttpInput): Promise<boolean> {
  const match = input.url.pathname.match(/^\/api\/teams\/([^/]+)\/agents\/([^/]+)\/workspace$/);
  if (!match) {
    return false;
  }
  if (input.request.method !== 'GET') {
    writeJson(input.response, 405, { ok: false, error: 'METHOD_NOT_ALLOWED' });
    return true;
  }
  const teamId = decodeURIComponent(match[1] ?? '');
  const agentId = decodeURIComponent(match[2] ?? '');
  const token = readToken(input.url, input.request);
  const session = token ? await input.app.whoami({ token }) : makeFailure('UNAUTHENTICATED', 'Missing session token');
  if (!session.ok) {
    writeAckFailure(input.response, session);
    return true;
  }
  const result = await input.app.listAgentWorkspaceRuns({
    userId: session.user.id,
    teamId,
    agentId,
  });
  if (!result.ok) {
    writeAckFailure(input.response, result);
    return true;
  }
  writeJson(input.response, 200, {
    ok: true,
    teamId,
    agentId,
    runs: result.runs.map((run) => ({
      ...run,
      files: run.files.map(withArtifactUrls),
    })),
  });
  return true;
}

async function handleAgentEnvHttp(input: ArtifactHttpInput): Promise<boolean> {
  const match = input.url.pathname.match(/^\/api\/teams\/([^/]+)\/agents\/([^/]+)\/env$/);
  if (!match) {
    return false;
  }
  if (input.request.method !== 'GET') {
    writeJson(input.response, 405, { ok: false, error: 'METHOD_NOT_ALLOWED' });
    return true;
  }
  const teamId = decodeURIComponent(match[1] ?? '');
  const agentId = decodeURIComponent(match[2] ?? '');
  const token = readBearerToken(input.request);
  if (!token) {
    writeJson(input.response, 401, { ok: false, error: 'UNAUTHENTICATED' });
    return true;
  }
  const result = await input.app.getAgentEnvForDevice({ token, teamId, agentId });
  if (!result.ok) {
    writeAckFailure(input.response, result);
    return true;
  }
  writeJson(input.response, 200, { ok: true, env: result.env });
  return true;
}

async function handleTeamWorkspaceRunsHttp(input: ArtifactHttpInput): Promise<boolean> {
  const match = input.url.pathname.match(/^\/api\/teams\/([^/]+)\/workspace-runs$/);
  if (!match) {
    return false;
  }
  if (input.request.method !== 'GET') {
    writeJson(input.response, 405, { ok: false, error: 'METHOD_NOT_ALLOWED' });
    return true;
  }
  const teamId = decodeURIComponent(match[1] ?? '');
  const token = readToken(input.url, input.request);
  const session = token ? await input.app.whoami({ token }) : makeFailure('UNAUTHENTICATED', 'Missing session token');
  if (!session.ok) {
    writeAckFailure(input.response, session);
    return true;
  }
  const status = parseWorkspaceRunStatus(input.url.searchParams.get('status'));
  if (status === 'invalid') {
    writeJson(input.response, 400, { ok: false, error: 'BAD_REQUEST', message: 'Invalid workspace run status' });
    return true;
  }
  const pageSizeParam = readOptionalQueryString(input.url, 'pageSize');
  const pageSize = pageSizeParam === undefined ? undefined : Number(pageSizeParam);
  const result = await input.app.listTeamWorkspaceRuns({
    userId: session.user.id,
    teamId,
    agentId: readOptionalQueryString(input.url, 'agentId'),
    deviceId: readOptionalQueryString(input.url, 'deviceId'),
    status,
    cursor: readOptionalQueryString(input.url, 'cursor'),
    pageSize: pageSize !== undefined && Number.isFinite(pageSize) ? pageSize : undefined,
  });
  if (!result.ok) {
    writeAckFailure(input.response, result);
    return true;
  }
  writeJson(input.response, 200, {
    ok: true,
    teamId,
    runs: result.runs.map((run) => ({
      workspaceRun: run.workspaceRun,
      artifacts: run.artifacts.map(withArtifactUrls),
    })),
    nextCursor: result.nextCursor,
  });
  return true;
}

async function handleWorkspaceRunHttp(input: ArtifactHttpInput): Promise<boolean> {
  const match = input.url.pathname.match(/^\/api\/teams\/([^/]+)\/workspace-runs\/([^/]+)$/);
  if (!match) {
    return false;
  }
  if (input.request.method !== 'GET') {
    writeJson(input.response, 405, { ok: false, error: 'METHOD_NOT_ALLOWED' });
    return true;
  }
  const teamId = decodeURIComponent(match[1] ?? '');
  const runId = decodeURIComponent(match[2] ?? '');
  const token = readToken(input.url, input.request);
  const session = token ? await input.app.whoami({ token }) : makeFailure('UNAUTHENTICATED', 'Missing session token');
  if (!session.ok) {
    writeAckFailure(input.response, session);
    return true;
  }
  const result = await input.app.getWorkspaceRunDetail({
    userId: session.user.id,
    teamId,
    runId,
  });
  if (!result.ok) {
    writeAckFailure(input.response, result);
    return true;
  }
  writeJson(input.response, 200, {
    ok: true,
    workspaceRun: result.workspaceRun,
    artifacts: result.artifacts,
  });
  return true;
}

async function handleWorkspaceRunLogHttp(input: ArtifactHttpInput): Promise<boolean> {
  const match = input.url.pathname.match(/^\/api\/teams\/([^/]+)\/workspace-runs\/([^/]+)\/log$/);
  if (!match) {
    return false;
  }
  if (input.request.method !== 'GET') {
    writeJson(input.response, 405, { ok: false, error: 'METHOD_NOT_ALLOWED' });
    return true;
  }
  const teamId = decodeURIComponent(match[1] ?? '');
  const runId = decodeURIComponent(match[2] ?? '');
  const token = readToken(input.url, input.request);
  const session = token ? await input.app.whoami({ token }) : makeFailure('UNAUTHENTICATED', 'Missing session token');
  if (!session.ok) {
    writeAckFailure(input.response, session);
    return true;
  }
  const result = await input.app.getWorkspaceRunLogFile({
    userId: session.user.id,
    teamId,
    runId,
  });
  if (!result.ok) {
    writeAckFailure(input.response, result);
    return true;
  }
  const storedPath = resolveStoredArtifactPath(input, result.storagePath);
  if (!storedPath.ok) {
    writeJson(input.response, storedPath.status, storedPath.payload);
    return true;
  }
  const query = readOptionalQueryString(input.url, 'query');
  const tailLines = clampIntegerQuery(input.url, 'tailLines', DEFAULT_WORKSPACE_LOG_TAIL_LINES, 1, 2000);
  const maxBytes = clampIntegerQuery(input.url, 'maxBytes', MAX_WORKSPACE_LOG_RESPONSE_BYTES, 1024, MAX_WORKSPACE_LOG_RESPONSE_BYTES);
  const log = query
    ? await searchWorkspaceRunLogFile({ absolutePath: storedPath.absolutePath, query, maxBytes })
    : readWorkspaceRunLogTail({ absolutePath: storedPath.absolutePath, tailLines, maxBytes });
  writeJson(input.response, 200, {
    ok: true,
    teamId,
    runId,
    artifact: withArtifactUrls(result.artifact),
    ...log,
  });
  return true;
}

async function handleArtifactHttp(input: ArtifactHttpInput): Promise<boolean> {
  const match = input.url.pathname.match(/^\/api\/teams\/([^/]+)\/artifacts(?:\/upload|\/([^/]+)\/(preview|download))$/);
  if (!match) {
    return false;
  }
  const teamId = decodeURIComponent(match[1] ?? '');
  try {
    if (input.request.method === 'POST' && input.url.pathname.endsWith('/upload')) {
      await handleArtifactUpload(input, teamId);
      return true;
    }
    const artifactId = match[2] ? decodeURIComponent(match[2]) : '';
    const disposition = match[3] === 'download' ? 'attachment' : 'inline';
    if (input.request.method === 'GET' && artifactId) {
      await handleArtifactRead(input, { teamId, artifactId, disposition });
      return true;
    }
    writeJson(input.response, 405, { ok: false, error: 'METHOD_NOT_ALLOWED' });
    return true;
  } catch (error) {
    if (error instanceof ArtifactHttpError) {
      writeJson(input.response, error.status, error.payload);
      return true;
    }
    const message = error instanceof Error ? error.message : String(error);
    writeJson(input.response, 500, { ok: false, error: 'INTERNAL_ERROR', message });
    return true;
  }
}

async function handleArtifactUpload(input: ArtifactHttpInput, teamId: string): Promise<void> {
  const upload = await readArtifactUpload(input);
  const token = readToken(input.url, input.request, upload.fields);
  const filename = sanitizeFilename(upload.filename);
  const artifactId = randomUUID();
  const relativeStoragePath = join('artifacts', teamId, artifactId, filename);
  const uploadInput = {
    teamId,
    channelId: upload.channelId,
    filename,
    mimeType: upload.mimeType,
    sizeBytes: upload.content.length,
    storagePath: relativeStoragePath,
    relativePath: filename,
    sha256: createHash('sha256').update(upload.content).digest('hex'),
  };
  const result = isDeviceToken(token)
    ? await input.app.uploadArtifactForDevice({ ...uploadInput, token })
    : await uploadArtifactForSession(input, token, uploadInput);
  if (!result.ok) {
    writeAckFailure(input.response, result);
    return;
  }
  const absoluteDir = join(input.config.dataDir, 'artifacts', teamId, artifactId);
  mkdirSync(absoluteDir, { recursive: true });
  writeFileSync(join(absoluteDir, filename), upload.content);
  writeJson(input.response, 201, {
    ok: true,
    artifact: withArtifactUrls(result.artifact),
  });
}

async function handleArtifactRead(
  input: ArtifactHttpInput,
  options: { teamId: string; artifactId: string; disposition: 'inline' | 'attachment' },
): Promise<void> {
  const token = readToken(input.url, input.request);
  const result = isDeviceToken(token)
    ? await input.app.getArtifactFileForDevice({ token, teamId: options.teamId, artifactId: options.artifactId })
    : await getArtifactFileForSession(input, token, options);
  if (!result.ok) {
    writeAckFailure(input.response, result);
    return;
  }
  const stored = readStoredArtifactBody(input, result.storagePath);
  if (!stored.ok) {
    writeJson(input.response, stored.status, stored.payload);
    return;
  }
  const disposition = shouldForceArtifactDownload(result.artifact.mimeType)
    ? 'attachment'
    : options.disposition;
  input.response.writeHead(200, {
    'content-type': result.artifact.mimeType,
    'content-length': String(stored.body.length),
    'content-disposition': buildContentDisposition(disposition, result.artifact.filename),
  });
  input.response.end(stored.body);
}

async function uploadArtifactForSession(
  input: ArtifactHttpInput,
  token: string | undefined,
  upload: {
    teamId: string;
    channelId: string;
    filename: string;
    mimeType: string;
    sizeBytes: number;
    storagePath: string;
    relativePath: string;
    sha256: string;
  },
): ReturnType<ArtifactHttpInput['app']['uploadArtifact']> {
  const session = token ? await input.app.whoami({ token }) : makeFailure('UNAUTHENTICATED', 'Missing session token');
  if (!session.ok) {
    return session;
  }
  return input.app.uploadArtifact({
    userId: session.user.id,
    ...upload,
  });
}

async function getArtifactFileForSession(
  input: ArtifactHttpInput,
  token: string | undefined,
  options: { teamId: string; artifactId: string },
): ReturnType<ArtifactHttpInput['app']['getArtifactFile']> {
  const session = token ? await input.app.whoami({ token }) : makeFailure('UNAUTHENTICATED', 'Missing session token');
  if (!session.ok) {
    return session;
  }
  return input.app.getArtifactFile({
    userId: session.user.id,
    teamId: options.teamId,
    artifactId: options.artifactId,
  });
}

function withArtifactUrls(artifact: ArtifactDto): ArtifactDto {
  return {
    ...artifact,
    previewUrl: `/api/teams/${encodeURIComponent(artifact.teamId)}/artifacts/${encodeURIComponent(artifact.id)}/preview`,
    downloadUrl: `/api/teams/${encodeURIComponent(artifact.teamId)}/artifacts/${encodeURIComponent(artifact.id)}/download`,
  };
}

async function readJsonBody(request: ArtifactHttpInput['request']): Promise<Record<string, unknown>> {
  const rawBody = await readRequestBody(request, MAX_ARTIFACT_UPLOAD_BODY_BYTES);
  if (rawBody.length === 0) return {};
  return parseJsonBody(rawBody);
}

async function readArtifactUpload(input: ArtifactHttpInput): Promise<{
  fields: Record<string, unknown>;
  channelId: string;
  filename: string;
  mimeType: string;
  content: Buffer;
}> {
  const contentType = input.request.headers['content-type'];
  if (typeof contentType === 'string' && contentType.toLowerCase().startsWith('multipart/form-data')) {
    const multipart = parseMultipartBody(await readRequestBody(input.request, MAX_ARTIFACT_UPLOAD_BODY_BYTES), contentType);
    return {
      fields: multipart.fields,
      channelId: readRequiredString(multipart.fields, 'channelId'),
      filename: multipart.file.filename,
      mimeType: multipart.file.mimeType,
      content: multipart.file.content,
    };
  }
  const body = await readJsonBody(input.request);
  const contentBase64 = readRequiredString(body, 'contentBase64');
  const content = Buffer.from(contentBase64, 'base64');
  if (content.length === 0 && contentBase64.length > 0) {
    throw new ArtifactHttpError(400, { ok: false, error: 'INVALID_CONTENT' });
  }
  return {
    fields: body,
    channelId: readRequiredString(body, 'channelId'),
    filename: readRequiredString(body, 'filename'),
    mimeType: typeof body.mimeType === 'string' && body.mimeType.trim()
      ? body.mimeType.trim()
      : 'application/octet-stream',
    content,
  };
}

async function readRequestBody(request: ArtifactHttpInput['request'], maxBytes: number): Promise<Buffer> {
  const contentLength = readContentLength(request);
  if (contentLength !== undefined && contentLength > maxBytes) {
    throw new ArtifactHttpError(413, { ok: false, error: 'PAYLOAD_TOO_LARGE' });
  }
  const chunks: Buffer[] = [];
  let received = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    received += buffer.length;
    if (received > maxBytes) {
      throw new ArtifactHttpError(413, { ok: false, error: 'PAYLOAD_TOO_LARGE' });
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function readContentLength(request: ArtifactHttpInput['request']): number | undefined {
  const rawLength = request.headers['content-length'];
  if (typeof rawLength !== 'string') {
    return undefined;
  }
  const parsed = Number(rawLength);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function parseJsonBody(rawBody: Buffer): Record<string, unknown> {
  const raw = rawBody.toString('utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ArtifactHttpError(400, { ok: false, error: 'BAD_REQUEST', message: 'Invalid JSON body' });
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ArtifactHttpError(400, { ok: false, error: 'BAD_REQUEST', message: 'Invalid JSON body' });
  }
  return parsed as Record<string, unknown>;
}

function parseMultipartBody(rawBody: Buffer, contentType: string): {
  fields: Record<string, string>;
  file: { filename: string; mimeType: string; content: Buffer };
} {
  const boundaryMatch = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  const boundary = boundaryMatch?.[1] ?? boundaryMatch?.[2];
  if (!boundary) {
    throw new ArtifactHttpError(400, { ok: false, error: 'BAD_REQUEST', message: 'Missing multipart boundary' });
  }
  const fields: Record<string, string> = {};
  let file: { filename: string; mimeType: string; content: Buffer } | undefined;
  const delimiter = Buffer.from(`--${boundary}`);
  let cursor = findMultipartBoundary(rawBody, delimiter, 0);
  while (cursor >= 0) {
    let partStart = cursor + delimiter.length;
    if (rawBody.subarray(partStart, partStart + 2).toString('latin1') === '--') break;
    if (rawBody.subarray(partStart, partStart + 2).toString('latin1') === '\r\n') {
      partStart += 2;
    } else if (rawBody.subarray(partStart, partStart + 1).toString('latin1') === '\n') {
      partStart += 1;
    }
    const next = findMultipartBoundary(rawBody, delimiter, partStart);
    if (next < 0) break;
    const part = trimTrailingLineBreak(rawBody.subarray(partStart, next));
    const separator = part.indexOf(Buffer.from('\r\n\r\n'));
    const fallbackSeparator = separator < 0 ? part.indexOf(Buffer.from('\n\n')) : -1;
    const headerEnd = separator >= 0 ? separator : fallbackSeparator;
    if (headerEnd >= 0) {
      const separatorLength = separator >= 0 ? 4 : 2;
      const headers = parseMultipartHeaders(part.subarray(0, headerEnd).toString('utf8'));
      const disposition = headers['content-disposition'] ?? '';
      const name = disposition.match(/(?:^|;\s*)name="([^"]+)"/)?.[1];
      const filename = disposition.match(/(?:^|;\s*)filename="([^"]*)"/)?.[1];
      const content = part.subarray(headerEnd + separatorLength);
      if (name && filename !== undefined) {
        file = {
          filename: filename || 'artifact.bin',
          mimeType: headers['content-type'] ?? 'application/octet-stream',
          content,
        };
      } else if (name) {
        fields[name] = content.toString('utf8');
      }
    }
    cursor = next;
  }
  if (!file) {
    throw new ArtifactHttpError(400, { ok: false, error: 'BAD_REQUEST', message: 'Missing multipart file' });
  }
  return { fields, file };
}

function findMultipartBoundary(rawBody: Buffer, delimiter: Buffer, from: number): number {
  let cursor = rawBody.indexOf(delimiter, from);
  while (cursor >= 0) {
    if (isMultipartBoundary(rawBody, delimiter, cursor)) return cursor;
    cursor = rawBody.indexOf(delimiter, cursor + 1);
  }
  return -1;
}

function isMultipartBoundary(rawBody: Buffer, delimiter: Buffer, cursor: number): boolean {
  const isAtLineStart = cursor === 0 || rawBody[cursor - 1] === 0x0a;
  if (!isAtLineStart) return false;
  const afterDelimiter = cursor + delimiter.length;
  return rawBody.subarray(afterDelimiter, afterDelimiter + 2).toString('latin1') === '--'
    || rawBody.subarray(afterDelimiter, afterDelimiter + 2).toString('latin1') === '\r\n'
    || rawBody.subarray(afterDelimiter, afterDelimiter + 1).toString('latin1') === '\n';
}

function parseMultipartHeaders(rawHeaders: string): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const line of rawHeaders.split(/\r?\n/)) {
    const index = line.indexOf(':');
    if (index > 0) {
      headers[line.slice(0, index).trim().toLowerCase()] = line.slice(index + 1).trim();
    }
  }
  return headers;
}

function trimTrailingLineBreak(value: Buffer): Buffer {
  if (value.subarray(-2).toString('latin1') === '\r\n') {
    return value.subarray(0, -2);
  }
  if (value.subarray(-1).toString('latin1') === '\n') {
    return value.subarray(0, -1);
  }
  return value;
}

function readToken(url: URL, request: ArtifactHttpInput['request'], body: Record<string, unknown> = {}): string | undefined {
  const queryToken = url.searchParams.get('token') ?? undefined;
  const bodyToken = typeof body.token === 'string' ? body.token : undefined;
  return readBearerToken(request) ?? queryToken ?? bodyToken;
}

function readBearerToken(request: ArtifactHttpInput['request']): string | undefined {
  const auth = request.headers.authorization;
  return typeof auth === 'string' && auth.startsWith('Bearer ') ? auth.slice('Bearer '.length) : undefined;
}

function isDeviceToken(token: string | undefined): token is string {
  return typeof token === 'string' && token.startsWith('abn_device.');
}

function readOptionalQueryString(url: URL, field: string): string | undefined {
  const value = url.searchParams.get(field);
  return value?.trim() || undefined;
}

function clampIntegerQuery(url: URL, field: string, fallback: number, min: number, max: number): number {
  const raw = readOptionalQueryString(url, field);
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function parseWorkspaceRunStatus(value: string | null): WorkspaceRunStatus | 'invalid' | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  return WORKSPACE_RUN_STATUSES.has(trimmed as WorkspaceRunStatus) ? trimmed as WorkspaceRunStatus : 'invalid';
}

function readRequiredString(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  if (typeof value !== 'string' || !value.trim()) {
    throw new ArtifactHttpError(400, { ok: false, error: 'BAD_REQUEST', message: `Missing ${field}` });
  }
  return value.trim();
}

function sanitizeFilename(filename: string): string {
  const safe = basename(filename).replace(/[^\w .@-]/g, '_').trim();
  return safe || 'artifact.bin';
}

function buildContentDisposition(disposition: 'inline' | 'attachment', filename: string): string {
  const fallback = basename(filename)
    .replace(/[^\x20-\x7E]/g, '')
    .replace(/["\\]/g, '')
    .replace(/\s+/g, ' ')
    .trim() || 'artifact.bin';
  return `${disposition}; filename="${fallback}"; filename*=UTF-8''${encodeRfc5987Value(filename)}`;
}

function shouldForceArtifactDownload(mimeType: string): boolean {
  return ACTIVE_PREVIEW_MIME_TYPES.has(mimeType.toLowerCase().split(';', 1)[0]?.trim() ?? '');
}

function readStoredArtifactBody(
  input: ArtifactHttpInput,
  storagePath: string | undefined,
): { ok: true; body: Buffer } | { ok: false; status: number; payload: unknown } {
  const storedPath = resolveStoredArtifactPath(input, storagePath);
  if (!storedPath.ok) return storedPath;
  return { ok: true, body: readFileSync(storedPath.absolutePath) };
}

function resolveStoredArtifactPath(
  input: ArtifactHttpInput,
  storagePath: string | undefined,
): { ok: true; absolutePath: string } | { ok: false; status: number; payload: unknown } {
  if (!storagePath) {
    return { ok: false, status: 404, payload: { ok: false, error: 'FILE_MISSING' } };
  }
  const dataRoot = resolve(input.config.dataDir);
  const absolutePath = resolve(dataRoot, storagePath);
  if (!isPathInside(dataRoot, absolutePath) || !existsSync(absolutePath)) {
    return { ok: false, status: 404, payload: { ok: false, error: 'FILE_MISSING' } };
  }
  return { ok: true, absolutePath };
}

function readWorkspaceRunLogTail(input: {
  absolutePath: string;
  tailLines: number;
  maxBytes: number;
}): {
  mode: 'tail';
  text: string;
  returnedLines: number;
  truncated: boolean;
} {
  const size = statSync(input.absolutePath).size;
  const readBytes = Math.min(size, input.maxBytes);
  if (readBytes <= 0) {
    return { mode: 'tail', text: '', returnedLines: 0, truncated: false };
  }
  const fd = openSync(input.absolutePath, 'r');
  try {
    const buffer = Buffer.alloc(readBytes);
    readSync(fd, buffer, 0, readBytes, size - readBytes);
    const lines = buffer.toString('utf8').split(/\r\n|\r|\n/);
    const droppedPartialPrefix = size > readBytes && !buffer.toString('utf8').startsWith('\n');
    const completeLines = droppedPartialPrefix ? lines.slice(1) : lines;
    const selectedLines = completeLines.slice(-input.tailLines);
    return {
      mode: 'tail',
      text: selectedLines.join('\n'),
      returnedLines: selectedLines.length,
      truncated: size > readBytes || completeLines.length > input.tailLines,
    };
  } finally {
    closeSync(fd);
  }
}

async function searchWorkspaceRunLogFile(input: {
  absolutePath: string;
  query: string;
  maxBytes: number;
}): Promise<{
  mode: 'search';
  text: string;
  totalLines: number;
  returnedLines: number;
  matchedLines: number;
  query: string;
  truncated: boolean;
}> {
  const query = input.query.trim();
  const normalizedQuery = query.toLowerCase();
  const stream = createReadStream(input.absolutePath, { encoding: 'utf8' });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  const selectedLines: string[] = [];
  let selectedBytes = 0;
  let totalLines = 0;
  let matchedLines = 0;
  let truncated = false;
  for await (const line of lines) {
    totalLines += 1;
    if (!line.toLowerCase().includes(normalizedQuery)) {
      continue;
    }
    matchedLines += 1;
    const nextBytes = Buffer.byteLength(line, 'utf8') + (selectedLines.length > 0 ? 1 : 0);
    if (selectedBytes + nextBytes <= input.maxBytes) {
      selectedLines.push(line);
      selectedBytes += nextBytes;
    } else {
      truncated = true;
    }
  }
  return {
    mode: 'search',
    text: selectedLines.join('\n'),
    totalLines,
    returnedLines: selectedLines.length,
    matchedLines,
    query,
    truncated: truncated || matchedLines > selectedLines.length,
  };
}

function encodeRfc5987Value(value: string): string {
  return encodeURIComponent(value).replace(/['()*]/g, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}

function isPathInside(root: string, candidate: string): boolean {
  const delta = relative(root, candidate);
  return delta === '' || (!!delta && !delta.startsWith('..') && !isAbsolute(delta));
}

function writeAckFailure(response: ArtifactHttpInput['response'], ack: { error?: string; message?: string }): void {
  const status = ack.error === 'UNAUTHENTICATED'
    ? 401
    : ack.error === 'FORBIDDEN'
      ? 403
      : ack.error === 'NOT_FOUND'
        ? 404
        : ack.error === 'CONFLICT'
          ? 409
          : 400;
  writeJson(response, status, { ok: false, error: ack.error ?? 'ERROR', message: ack.message });
}

function writeInternalHttpError(response: ArtifactHttpInput['response'], error: unknown): void {
  console.error(
    '[server-next] HTTP request threw:',
    error instanceof Error ? error.stack ?? error.message : error,
  );
  if (!response.headersSent) {
    writeJson(response, 500, { ok: false, error: 'INTERNAL_ERROR', message: INTERNAL_HTTP_ERROR_MESSAGE });
    return;
  }
  response.end();
}

function writeJson(response: ArtifactHttpInput['response'], status: number, payload: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(payload));
}

class ArtifactHttpError extends Error {
  constructor(
    readonly status: number,
    readonly payload: unknown,
  ) {
    super('Artifact HTTP request failed');
  }
}

function readPreviewHtml(): string {
  const path = findPreviewHtmlPath();
  if (path) {
    return readFileSync(path, 'utf8');
  }
  throw new Error('web-next preview page not found');
}

async function createWebAppHandler(config: ServerNextDevConfig): Promise<WebAppHandler> {
  const createNextApp = loadNextAppFactory();
  const dir = findWebNextDir();
  console.log(`AgentBean Next preparing web app from ${dir}`);
  const nextApp = createNextApp({
    dev: false,
    dir,
    hostname: config.host,
    port: config.port,
  });
  await nextApp.prepare();
  console.log('AgentBean Next web app prepared');
  const handle = nextApp.getRequestHandler();
  return {
    async handle(request, response) {
      await handle(request, response);
    },
    async close() {
      await nextApp.close();
    },
  };
}

function loadNextAppFactory(): NextAppFactory {
  const requireFromHere = createRequire(import.meta.url);
  const loaded = requireFromHere('next') as NextAppFactory | { default?: NextAppFactory };
  if (typeof loaded === 'function') {
    return loaded;
  }
  if (typeof loaded.default === 'function') {
    return loaded.default;
  }
  throw new Error('next module did not expose an app factory');
}

function findWebNextDir(): string {
  const previewPath = findPreviewHtmlPath();
  if (previewPath) {
    return dirname(dirname(previewPath));
  }
  const candidates = [
    new URL('../../../../../web-next', import.meta.url),
    new URL('../../web-next', import.meta.url),
    pathToFileURL(join(process.cwd(), 'apps/web-next')),
  ];
  for (const candidate of candidates) {
    try {
      const path = candidate.pathname;
      if (existsSync(join(path, 'package.json'))) {
        return path;
      }
    } catch {
      // Try the next known repository layout.
    }
  }
  throw new Error('web-next app directory not found');
}

function createDefaultApp(
  config: ServerNextDevConfig,
  Database: BetterSqlite3Constructor | undefined,
): AppWithCleanup {
  const artifactContentStore = createFileArtifactContentStore(config.dataDir);
  if (config.storage === 'memory') {
    const repositories = createInMemoryRepositories();
    const clock = { now: () => Date.now() };
    const ids = { nextId: () => randomUUID() };
    const management = createDefaultManagementRuntime(repositories, clock, ids);
    const taskClaimBroker = createTaskClaimBroker({ repositories, clock, ids });
    const serverCapsuleRuntimeContextResolver = createDefaultServerCapsuleRuntimeContextResolver(
      repositories, ids,
    );
    return {
      app: createServerNextUseCases({
        repositories,
        clock,
        ids,
        sessionSecret: config.sessionSecret,
        artifactContentStore,
        managementRouter: management.router,
        managementKernel: management.kernel,
        taskCoordinationKernel: management.taskCoordinationKernel,
        serverCapsuleRuntimeContextResolver,
      }),
      managementWorkerScheduler: management.scheduler,
      taskClaimBroker,
      bindManagementDispatchEmitter: management.bindDispatchEmitter,
      bindTaskClaimEmitter: management.bindTaskClaimEmitter,
      reconcileDisconnectedDevicesOnStart: false,
      close: async () => undefined,
    };
  }

  mkdirSync(config.dataDir, { recursive: true });
  const Sqlite = Database ?? loadBetterSqlite3();
  const globalDb = new Sqlite(join(config.dataDir, 'global.sqlite'));
  const teamDb = new Sqlite(join(config.dataDir, 'team.sqlite'));
  applyGlobalMigrations(globalDb);
  applyTeamMigrations(teamDb);
  // PRD §6：清理 channel_agent_members 中被 0009 删除的 executor-hosted agent 留下的孤儿行。
  // 必须在两个迁移都跑完后、且 globalDbPath 已知时执行（详见函数注释）。
  cleanupOrphanedChannelMembers(join(config.dataDir, 'global.sqlite'), teamDb);
  const repositories = createSqliteRepositories({ globalDb, teamDb });
  const clock = { now: () => Date.now() };
  const ids = { nextId: () => randomUUID() };
  const management = createDefaultManagementRuntime(repositories, clock, ids);
  const taskClaimBroker = createTaskClaimBroker({ repositories, clock, ids });
  const serverCapsuleRuntimeContextResolver = createDefaultServerCapsuleRuntimeContextResolver(
    repositories, ids,
  );
  return {
    app: createServerNextUseCases({
      repositories,
      clock,
      ids,
      sessionSecret: config.sessionSecret,
      artifactContentStore,
      managementRouter: management.router,
      managementKernel: management.kernel,
      taskCoordinationKernel: management.taskCoordinationKernel,
      serverCapsuleRuntimeContextResolver,
    }),
    managementWorkerScheduler: management.scheduler,
    taskClaimBroker,
    bindManagementDispatchEmitter: management.bindDispatchEmitter,
    bindTaskClaimEmitter: management.bindTaskClaimEmitter,
    reconcileDisconnectedDevicesOnStart: true,
    async close() {
      globalDb.close();
      teamDb.close();
    },
  };
}

function createDefaultServerCapsuleRuntimeContextResolver(
  repositories: ServerNextRepositories,
  ids: { nextId(): string },
) {
  const validator = createCapsuleInjectionValidator({
    unitOfWork: repositories.memoryUnitOfWork,
    permissions: createServerMemorySearchPermissions(repositories),
    ids,
  });
  return createServerCapsuleRuntimeContextService({
    unitOfWork: repositories.memoryUnitOfWork,
    validator,
    ids,
    currentPolicyVersion: () => CURRENT_MEMORY_POLICY_VERSION,
  });
}

function createDefaultManagementRuntime(
  repositories: ServerNextRepositories,
  clock: { now(): number },
  ids: { nextId(): string },
) {
  let dispatchEmitter: ((dispatchId: string) => Promise<void>) | undefined;
  let taskClaimEmitter: ((taskId: string) => Promise<void>) | undefined;
  const kernel = createManagementKernel({
    repositories: repositories.management,
    unitOfWork: repositories.managementUnitOfWork,
    clock,
    ids,
  });
  const taskCoordinationKernel = createTaskCoordinationKernel({
    unitOfWork: repositories.taskCoordinationUnitOfWork,
    clock,
    ids,
  });
  const subtaskAcceptanceService = createSubtaskAcceptanceService({
    unitOfWork: repositories.taskCoordinationUnitOfWork,
    clock,
    ids,
  });
  const memorySearchService = createCollaborativeMemorySearchService({
    repositories: repositories.memory,
    permissions: createServerMemorySearchPermissions(repositories),
  });
  const memoryCapsuleService = createMemoryCapsuleService({
    searchService: memorySearchService,
    unitOfWork: repositories.memoryUnitOfWork,
    clock,
    ids,
  });
  const memoryCandidateService = createMemoryCandidateService({
    unitOfWork: repositories.memoryUnitOfWork,
    permissions: createServerMemoryCandidatePermissions(repositories),
    clock,
    ids,
  });
  const collaborativeMemoryService = createCollaborativeMemoryService({
    unitOfWork: repositories.memoryUnitOfWork,
    permissions: createServerMemoryWritePermissions(repositories),
    clock,
    ids,
  });
  const scheduler = createDeviceWorkerScheduler({
    devices: repositories.devices,
    messages: repositories.messages,
    management: repositories.management,
    memory: repositories.memory,
    taskCoordinationUnitOfWork: repositories.taskCoordinationUnitOfWork,
    kernel,
    executeTool: createManagementToolExecutor({
      kernel,
      handlers: createPhase1ManagementToolHandlers({
        repositories,
        kernel,
        taskCoordinationKernel,
        clock,
        ids,
        onDispatchCreated: async (dispatchId) => {
          if (!dispatchEmitter) throw new Error('MANAGEMENT_DISPATCH_EMITTER_UNAVAILABLE');
          await dispatchEmitter(dispatchId);
        },
      }),
      phase2Handlers: {
        ...createPhase2ManagementToolHandlers({ kernel: taskCoordinationKernel,
          acceptanceService: subtaskAcceptanceService,
          onTaskPublished: async (taskId) => {
            if (!taskClaimEmitter) throw new Error('TASK_CLAIM_EMITTER_UNAVAILABLE');
            await taskClaimEmitter(taskId);
          } }),
        ...createPhase2InvocationToolHandlers({
          repositories,
          kernel,
          taskCoordinationKernel,
          clock,
          ids,
          onDispatchCreated: async (dispatchId) => {
            if (!dispatchEmitter) throw new Error('MANAGEMENT_DISPATCH_EMITTER_UNAVAILABLE');
            await dispatchEmitter(dispatchId);
          },
        }),
        ...createPhase2CollaborationToolHandlers({
          repositories,
          clock,
          ids,
          onDispatchCreated: async (dispatchId) => {
            if (!dispatchEmitter) throw new Error('MANAGEMENT_DISPATCH_EMITTER_UNAVAILABLE');
            await dispatchEmitter(dispatchId);
          },
        }),
      },
      phase3Handlers: createPhase3ManagementToolHandlers({
        repositories,
        searchService: memorySearchService,
        capsuleService: memoryCapsuleService,
        candidateService: memoryCandidateService,
        collaborativeService: collaborativeMemoryService,
        clock,
        currentPolicyVersion: CURRENT_MEMORY_POLICY_VERSION,
      }),
    }),
    clock,
    ids,
    leaseTokens: { nextToken: () => randomBytes(32).toString('base64url') },
  });
  const router = createManagementRouter({
    repositories,
    kernel,
    clock,
    ids,
    gateway: {
      async preflight({ teamId, target, placementPolicy }) {
        const device = target.deviceId ? await repositories.devices.getById(target.deviceId) : null;
        if (!device?.profileId) {
          return { workerAvailable: false, credentialAvailable: false, placementAllowed: false, budgetAvailable: true, targetAvailable: false };
        }
        return scheduler.managementPreflight({
          teamId,
          deviceId: device.id,
          profileId: device.profileId,
          placementPolicy,
          targetAvailable: target.status !== 'offline' && device.status === 'online',
        });
      },
      async preflightPhase2({ teamId, target, placementPolicy }) {
        return scheduler.managementPhase2Preflight({
          teamId,
          placementPolicy,
          targetAvailable: target ? target.status !== 'offline' : true,
        });
      },
      async preflightPhase3({ teamId, target, placementPolicy }) {
        return scheduler.managementPhase3Preflight({
          teamId,
          placementPolicy,
          targetAvailable: target ? target.status !== 'offline' : true,
        });
      },
      schedule: (input) => scheduler.scheduleManagementRun(input),
    },
  });
  return {
    kernel,
    taskCoordinationKernel,
    scheduler,
    router,
    bindDispatchEmitter(emit: (dispatchId: string) => Promise<void>) {
      dispatchEmitter = emit;
    },
    bindTaskClaimEmitter(emit: (taskId: string) => Promise<void>) {
      taskClaimEmitter = emit;
    },
  };
}

function findPreviewHtmlPath(): string | undefined {
  const candidates = [
    new URL('../../../../../web-next/preview/index.html', import.meta.url),
    new URL('../../web-next/preview/index.html', import.meta.url),
    pathToFileURL(join(process.cwd(), 'apps/web-next/preview/index.html')),
  ];
  for (const candidate of candidates) {
    try {
      const path = candidate.pathname;
      if (existsSync(path)) {
        return path;
      }
    } catch {
      // Try the next known repository layout.
    }
  }
  return undefined;
}

function createFileArtifactContentStore(dataDir: string): ArtifactContentStore {
  return {
    async writeContent(input) {
      const filename = sanitizeFilename(input.filename);
      const relativeStoragePath = join('artifacts', input.teamId, input.artifactId, filename);
      const absoluteDir = join(dataDir, 'artifacts', input.teamId, input.artifactId);
      mkdirSync(absoluteDir, { recursive: true });
      writeFileSync(join(absoluteDir, filename), input.content);
      return {
        storagePath: relativeStoragePath,
        sizeBytes: input.content.length,
        sha256: createHash('sha256').update(input.content).digest('hex'),
      };
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
    new URL('../package.json', import.meta.url),
    new URL('../../../../package.json', import.meta.url),
    pathToFileURL(join(process.cwd(), 'apps/server-next/package.json')),
  ];
  for (const requireUrl of requireUrls) {
    try {
      const loaded = createRequire(requireUrl)('socket.io') as { Server: SocketIoServerConstructor };
      return loaded.Server;
    } catch {
      // Try the next known repository layout.
    }
  }
  throw new Error('socket.io is not installed; run npm ci at the repository root');
}

function loadBetterSqlite3(): BetterSqlite3Constructor {
  const requireUrls = [
    new URL('../package.json', import.meta.url),
    new URL('../../../../package.json', import.meta.url),
    pathToFileURL(join(process.cwd(), 'apps/server-next/package.json')),
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
  throw new Error('better-sqlite3 is not installed for this Node.js runtime; run npm ci at the repository root');
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
