import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http';
import { createRequire } from 'node:module';
import { createHash, randomUUID } from 'node:crypto';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServerNextUseCases, type ArtifactContentStore } from './application/usecases.js';
import { createInMemoryRepositories } from './infra/memory/repositories.js';
import {
  applyGlobalMigrations,
  applyTeamMigrations,
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

const MAX_ARTIFACT_UPLOAD_BODY_BYTES = 10 * 1024 * 1024;
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
  const httpServer = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://agentbean-next.local');
    if (url.pathname === '/' || url.pathname === '/preview') {
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
    if (await handleWorkspaceRunHttp({ app, config, request, response, url })) {
      return;
    }
    if (await handleArtifactHttp({ app, config, request, response, url })) {
      return;
    }
    if (await handleAgentEnvHttp({ app, config, request, response, url })) {
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
  if (!result.storagePath) {
    writeJson(input.response, 404, { ok: false, error: 'FILE_MISSING' });
    return;
  }
  const dataRoot = resolve(input.config.dataDir);
  const absolutePath = resolve(dataRoot, result.storagePath);
  if (!isPathInside(dataRoot, absolutePath)) {
    writeJson(input.response, 404, { ok: false, error: 'FILE_MISSING' });
    return;
  }
  if (!existsSync(absolutePath)) {
    writeJson(input.response, 404, { ok: false, error: 'FILE_MISSING' });
    return;
  }
  const body = readFileSync(absolutePath);
  const disposition = shouldForceArtifactDownload(result.artifact.mimeType)
    ? 'attachment'
    : options.disposition;
  input.response.writeHead(200, {
    'content-type': result.artifact.mimeType,
    'content-length': String(body.length),
    'content-disposition': buildContentDisposition(disposition, result.artifact.filename),
  });
  input.response.end(body);
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
  const artifactContentStore = createFileArtifactContentStore(config.dataDir);
  if (config.storage === 'memory') {
    return {
      app: createServerNextUseCases({
        repositories: createInMemoryRepositories(),
        clock: { now: () => Date.now() },
        ids: {
          nextId: () => randomUUID(),
        },
        sessionSecret: config.sessionSecret,
        artifactContentStore,
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
      artifactContentStore,
    }),
    async close() {
      globalDb.close();
      teamDb.close();
    },
  };
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
