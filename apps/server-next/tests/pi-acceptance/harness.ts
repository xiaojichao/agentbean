/**
 * #725 PI Agent MVP 全链路验收 harness。
 *
 * 组装真实链路：真实 Socket.IO（/web + /agent 命名空间）+ 真实 SQLite（tmpdir）
 * + 真实本地 HTTP 的可控 OpenAI-compatible Provider + 真实 Agent 协议（task-claim 事件）。
 * 生产装配复用 createDefaultApp（不再复刻接线），durable-job 摄入模式，
 * 协调调度默认关闭（intervalMs=0），测试经 app.runCoordinationCycle 确定性驱动。
 */
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

import { AGENT_EVENTS, WEB_EVENTS } from '../../../../packages/contracts/src/index';
import {
  createDefaultApp,
  startServerNextDevServer,
  type AppWithCleanup,
  type ServerNextDevConfig,
  type ServerNextDevServerHandle,
} from '../../src/dev-server.js';
import type { ServerNextUseCases } from '../../src/application/usecases.js';

type BetterSqlite3Database = import('better-sqlite3').Database;
const requireFromServer = createRequire(new URL('../../package.json', import.meta.url));
const BetterSqlite3 = requireFromServer('better-sqlite3') as new (filename: string) => BetterSqlite3Database;
const { io: createClient } = requireFromServer('socket.io-client') as {
  io(url: string, options?: Record<string, unknown>): ClientSocket;
};

export interface ClientSocket {
  connected: boolean;
  connect(): void;
  disconnect(): void;
  emit(event: string, payload: unknown): void;
  emitWithAck(event: string, payload: unknown): Promise<unknown>;
  on(event: string, handler: (...args: unknown[]) => void): void;
  off(event: string, handler: (...args: unknown[]) => void): void;
}

// ─────────────────────────────────────────────────────────────────────────────
// 可控 OpenAI-compatible Provider（真实 HTTP server，脚本化响应队列）
// ─────────────────────────────────────────────────────────────────────────────

export type ProviderResponseSpec =
  | { readonly kind: 'chat'; readonly body: unknown; readonly status?: number }
  | { readonly kind: 'raw'; readonly body: string; readonly status?: number }
  | { readonly kind: 'error'; readonly status: number; readonly message?: string }
  | { readonly kind: 'hang' };

export interface RecordedProviderRequest {
  readonly kind: 'probe' | 'coordination';
  readonly authorization: string | null;
  readonly model: string | null;
  readonly userText: string | null;
}

export interface ControllableProvider {
  readonly baseUrl: string;
  readonly requests: RecordedProviderRequest[];
  /** 追加一条协调响应（按队列消费；空队列收到协调请求返回 500 暴露意外调用）。 */
  push(spec: ProviderResponseSpec): void;
  /** 已到达的协调请求数（不含 provider 上线 probe）。 */
  coordinationCalls(): number;
  close(): Promise<void>;
}

/** 构造一条合法的 chat completion 协调响应（content 为意图 JSON 字符串）。 */
export function coordinationChatBody(
  intent: Record<string, unknown>,
  options: { readonly model?: string; readonly withUsage?: boolean } = {},
): unknown {
  const body: Record<string, unknown> = {
    model: options.model ?? 'pi-acceptance-model',
    choices: [{
      index: 0,
      message: { role: 'assistant', content: JSON.stringify(intent) },
      finish_reason: 'stop',
    }],
  };
  if (options.withUsage !== false) {
    body.usage = { prompt_tokens: 12, completion_tokens: 7, total_tokens: 19 };
  }
  return body;
}

function isProbeRequest(messages: readonly Record<string, unknown>[]): boolean {
  const system = messages.find((message) => message.role === 'system');
  return typeof system?.content === 'string' && system.content.includes('connectivity probe');
}

function probeAnswer(messages: readonly Record<string, unknown>[], model: string | null): unknown {
  const usage = { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 };
  const system = messages.find((message) => message.role === 'system');
  const systemText = typeof system?.content === 'string' ? system.content : '';
  const hasToolResult = messages.some((message) => message.role === 'tool');
  if (hasToolResult) {
    return {
      model: model ?? 'pi-acceptance-model',
      choices: [{ index: 0, message: { role: 'assistant', content: 'DONE' }, finish_reason: 'stop' }],
      usage,
    };
  }
  if (systemText.includes('context.get_root_message')) {
    return {
      model: model ?? 'pi-acceptance-model',
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: 'call-probe-1',
            type: 'function',
            function: { name: 'context.get_root_message', arguments: '{}' },
          }],
        },
        finish_reason: 'tool_calls',
      }],
      usage,
    };
  }
  return {
    model: model ?? 'pi-acceptance-model',
    choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }],
    usage,
  };
}

export async function startControllableProvider(): Promise<ControllableProvider> {
  const queue: ProviderResponseSpec[] = [];
  const requests: RecordedProviderRequest[] = [];
  const server = createServer((request, response) => {
    if (request.method !== 'POST' || !request.url?.endsWith('/chat/completions')) {
      response.writeHead(404, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: 'not found' } }));
      return;
    }
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      let parsed: Record<string, unknown> = {};
      try {
        parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
      } catch {
        /* 保持空对象，按协调请求走脚本队列（空队列→500） */
      }
      const messages = Array.isArray(parsed.messages) ? (parsed.messages as Record<string, unknown>[]) : [];
      const probe = isProbeRequest(messages);
      const userMessage = [...messages].reverse().find((message) => message.role === 'user');
      requests.push({
        kind: probe ? 'probe' : 'coordination',
        authorization: typeof request.headers.authorization === 'string' ? request.headers.authorization : null,
        model: typeof parsed.model === 'string' ? parsed.model : null,
        userText: typeof userMessage?.content === 'string' ? userMessage.content : null,
      });
      if (probe) {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify(probeAnswer(messages, typeof parsed.model === 'string' ? parsed.model : null)));
        return;
      }
      const spec = queue.shift();
      if (!spec) {
        response.writeHead(500, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: { message: 'controllable provider: no scripted response' } }));
        return;
      }
      if (spec.kind === 'hang') return; // 永不响应，注入超时
      if (spec.kind === 'error') {
        response.writeHead(spec.status, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: { message: spec.message ?? `injected ${spec.status}` } }));
        return;
      }
      if (spec.kind === 'raw') {
        response.writeHead(spec.status ?? 200, { 'content-type': 'application/json' });
        response.end(spec.body);
        return;
      }
      response.writeHead(spec.status ?? 200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(spec.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    push(spec) {
      queue.push(spec);
    },
    coordinationCalls() {
      return requests.filter((entry) => entry.kind === 'coordination').length;
    },
    async close() {
      // hang 中的挂起连接随 server close 由 better 端 abort；closeAllConnections 兜底。
      const closable = server as HttpServer & { closeAllConnections?: () => void };
      closable.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 验收服务器（生产装配 + durable-job + 手动协调驱动）
// ─────────────────────────────────────────────────────────────────────────────

export interface AcceptanceServer {
  readonly baseUrl: string;
  readonly dataDir: string;
  readonly app: ServerNextUseCases;
  readonly bundle: AppWithCleanup;
  openTeamDb(): BetterSqlite3Database;
  openGlobalDb(): BetterSqlite3Database;
  close(): Promise<void>;
}

export async function bootAcceptanceServer(input: {
  readonly dataDir?: string;
  readonly coordinationIntervalMs?: number;
} = {}): Promise<AcceptanceServer> {
  process.env.AGENTBEAN_PI_SECRET_KEY ??= 'pi-acceptance-secret-key-0123456';
  const ownsDataDir = input.dataDir === undefined;
  const dataDir = input.dataDir ?? mkdtempSync(join(tmpdir(), 'agentbean-pi-acceptance-'));
  const config: ServerNextDevConfig = {
    host: '127.0.0.1',
    port: 0,
    storage: 'sqlite',
    dataDir,
    sessionSecret: 'pi-acceptance-session-secret',
    webEntry: 'preview',
  };
  const bundle = createDefaultApp(config, BetterSqlite3 as never, 'durable-job');
  const server: ServerNextDevServerHandle = await startServerNextDevServer({
    app: bundle.app,
    managementWorkerScheduler: bundle.managementWorkerScheduler,
    serverWorkerScheduler: bundle.serverWorkerScheduler,
    taskClaimBroker: bundle.taskClaimBroker,
    serverWorkerPool: bundle.serverWorkerPool,
    serverWorkerAuthToken: bundle.serverWorkerAuthToken,
    bindManagementDispatchEmitter: bundle.bindManagementDispatchEmitter,
    bindTaskClaimEmitter: bundle.bindTaskClaimEmitter,
    onClose: bundle.close,
    config,
    coordination: { intervalMs: input.coordinationIntervalMs ?? 0 },
    dispatchTimeout: { timeoutMs: 60_000, intervalMs: 60_000 },
  });
  return {
    baseUrl: server.baseUrl,
    dataDir,
    app: bundle.app,
    bundle,
    openTeamDb() {
      const db = new BetterSqlite3(join(dataDir, 'team.sqlite'));
      db.pragma('busy_timeout = 2000');
      return db;
    },
    openGlobalDb() {
      const db = new BetterSqlite3(join(dataDir, 'global.sqlite'));
      db.pragma('busy_timeout = 2000');
      return db;
    },
    async close() {
      await server.close();
      if (ownsDataDir) rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Socket 客户端与身份
// ─────────────────────────────────────────────────────────────────────────────

export async function connectSocket(url: string, options: Record<string, unknown> = {}): Promise<ClientSocket> {
  const socket = createClient(url, { transports: ['websocket'], forceNew: true, reconnection: false, ...options });
  await new Promise<void>((resolve, reject) => {
    socket.on('connect', () => resolve());
    socket.on('connect_error', (error: unknown) => reject(error instanceof Error ? error : new Error(String(error))));
    socket.connect();
  });
  return socket;
}

export interface AcceptanceUser {
  readonly socket: ClientSocket;
  readonly token: string;
  readonly userId: string;
  readonly teamId: string;
  readonly channelId: string;
  emitWithAck(event: string, payload: unknown): Promise<unknown>;
  sendMessage(input: {
    readonly body: string;
    readonly channelId?: string;
    readonly clientMessageId?: string;
    readonly threadId?: string;
    readonly asTask?: boolean;
    readonly mentions?: readonly { readonly kind: string; readonly id: string; readonly name: string }[];
  }): Promise<Record<string, unknown>>;
}

function wrapUser(socket: ClientSocket, registered: {
  readonly token: string;
  readonly user: { readonly id: string };
  readonly currentTeam: { readonly id: string };
  readonly defaultChannel: { readonly id: string };
}): AcceptanceUser {
  const base = {
    socket,
    token: registered.token,
    userId: registered.user.id,
    teamId: registered.currentTeam.id,
    channelId: registered.defaultChannel.id,
    emitWithAck: (event: string, payload: unknown) => socket.emitWithAck(event, payload),
  };
  return {
    ...base,
    async sendMessage(input) {
      return (await socket.emitWithAck(WEB_EVENTS.message.send, {
        userId: base.userId,
        teamId: base.teamId,
        channelId: input.channelId ?? base.channelId,
        body: input.body,
        ...(input.clientMessageId ? { clientMessageId: input.clientMessageId } : {}),
        ...(input.threadId ? { threadId: input.threadId } : {}),
        ...(input.asTask === true ? { asTask: true } : {}),
        ...(input.mentions ? { meta: { mentions: input.mentions } } : {}),
      })) as Record<string, unknown>;
    },
  };
}

export async function registerUser(
  baseUrl: string,
  profile: { readonly username: string; readonly password?: string; readonly teamName?: string; readonly joinCode?: string },
): Promise<AcceptanceUser> {
  const socket = await connectSocket(`${baseUrl}/web`);
  const registered = (await socket.emitWithAck(WEB_EVENTS.auth.register, {
    username: profile.username,
    password: profile.password ?? 'acceptance-secret',
    teamName: profile.teamName ?? `${profile.username}-team`,
    ...(profile.joinCode ? { joinCode: profile.joinCode } : {}),
  })) as {
    token: string;
    user: { id: string };
    currentTeam: { id: string };
    defaultChannel: { id: string };
  };
  socket.disconnect();
  const authed = await connectSocket(`${baseUrl}/web`, { auth: { token: registered.token } });
  return wrapUser(authed, registered);
}

/** 把已注册用户提升为系统管理员（无生产提升入口，验收直接写 global DB）。 */
export function promoteToSystemAdmin(server: AcceptanceServer, userId: string): void {
  const db = server.openGlobalDb();
  try {
    db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(userId);
  } finally {
    db.close();
  }
}

/** 建第二张身份卡：owner 创建 join link，新用户经 joinCode 加入同一 Team。 */
export async function inviteMember(owner: AcceptanceUser, baseUrl: string, username: string): Promise<AcceptanceUser> {
  const joinLink = (await owner.emitWithAck(WEB_EVENTS.join.create, {
    userId: owner.userId,
    teamId: owner.teamId,
  })) as { ok: boolean; link: { code: string } };
  if (!joinLink.ok) throw new Error(`join:create failed: ${JSON.stringify(joinLink)}`);
  return registerUser(baseUrl, { username, joinCode: joinLink.link.code });
}

// ─────────────────────────────────────────────────────────────────────────────
// PI Provider Supply：建卡 → 生产同路径测试 → 发布 → 设为全局 Active Model
// ─────────────────────────────────────────────────────────────────────────────

export async function activateControllablePiModel(
  server: AcceptanceServer,
  adminUserId: string,
  provider: ControllableProvider,
  options: { readonly timeoutMs?: number } = {},
): Promise<{ readonly cardId: string; readonly revisionId: string }> {
  const created = await server.app.createPiProviderCard({
    userId: adminUserId,
    preset: 'custom_openai_compatible',
    displayName: 'Acceptance Provider',
    baseUrl: provider.baseUrl,
    endpointMode: 'chat_completions',
    modelId: 'pi-acceptance-model',
    timeoutMs: options.timeoutMs ?? 2_000,
    maxOutputTokens: 512,
    notes: 'pi mvp acceptance',
    apiKey: 'sk-acceptance-secret-api-key',
  });
  if (!created.ok) throw new Error(`createPiProviderCard failed: ${JSON.stringify(created)}`);
  const cardId = created.card.id;
  const tested = await server.app.runPiProviderTest({ userId: adminUserId, cardId });
  if (!tested.ok) throw new Error(`runPiProviderTest failed: ${JSON.stringify(tested)}`);
  const published = await server.app.publishPiProviderCard({ userId: adminUserId, cardId });
  if (!published.ok) throw new Error(`publishPiProviderCard failed: ${JSON.stringify(published)}`);
  const revisionId = published.card.publishedRevision!.id;
  const activated = await server.app.setActivePiModel({ userId: adminUserId, revisionId });
  if (!activated.ok) throw new Error(`setActivePiModel failed: ${JSON.stringify(activated)}`);
  return { cardId, revisionId };
}

// ─────────────────────────────────────────────────────────────────────────────
// Agent 协议端：device hello → runtime → createAgent → skills → exposure manifest
// ─────────────────────────────────────────────────────────────────────────────

export interface AcceptanceAgent {
  readonly socket: ClientSocket;
  readonly deviceId: string;
  readonly agentId: string;
  readonly name: string;
}

export async function registerDeviceAgent(
  owner: AcceptanceUser,
  baseUrl: string,
  profile: {
    readonly name: string;
    readonly machineId: string;
    readonly skills?: readonly string[];
    readonly capabilities?: readonly string[];
    readonly withManifest?: boolean;
  },
): Promise<AcceptanceAgent> {
  const socket = await connectSocket(`${baseUrl}/agent`);
  const hello = (await socket.emitWithAck(AGENT_EVENTS.device.hello, {
    teamId: owner.teamId,
    ownerId: owner.userId,
    machineId: profile.machineId,
    profileId: 'default',
  })) as { device: { id: string } };
  const reported = (await socket.emitWithAck(AGENT_EVENTS.device.runtimes, {
    teamId: owner.teamId,
    deviceId: hello.device.id,
    runtimes: [{ adapterKind: 'codex-cli', name: 'Codex CLI' }],
  })) as { runtimes: Array<{ id: string }> };
  const created = (await owner.emitWithAck(WEB_EVENTS.agent.create, {
    userId: owner.userId,
    teamId: owner.teamId,
    deviceId: hello.device.id,
    runtimeId: reported.runtimes[0]!.id,
    name: profile.name,
    env: {},
  })) as { agent: { id: string } };
  const agentId = created.agent.id;
  const legacySkills = (profile.skills ?? []).map((name) => ({
    name,
    description: `${name} skill`,
    scope: 'user',
    sourcePath: `/acceptance/${name}/SKILL.md`,
    adapterKind: 'codex-cli',
  }));
  await socket.emitWithAck(AGENT_EVENTS.agent.reportCustomSkills, {
    teamId: owner.teamId,
    deviceId: hello.device.id,
    items: [{ agentId, skills: legacySkills }],
  });
  if (profile.withManifest !== false) {
    const draft = await owner.emitWithAck(WEB_EVENTS.agentExposure.createDraft, {
      userId: owner.userId,
      teamId: owner.teamId,
      agentId,
      capabilities: (profile.capabilities ?? profile.skills ?? []).map((name) => ({
        name,
        description: `${name} capability`,
      })),
      skills: (profile.skills ?? []).map((name) => ({ name, description: `${name} skill` })),
      availability: { status: 'available' },
    });
    const draftAck = draft as { ok: boolean; manifest?: { id: string } };
    if (!draftAck.ok || !draftAck.manifest) {
      throw new Error(`agent-exposure:create-draft failed: ${JSON.stringify(draft)}`);
    }
    const published = (await owner.emitWithAck(WEB_EVENTS.agentExposure.publish, {
      userId: owner.userId,
      teamId: owner.teamId,
      manifestId: draftAck.manifest.id,
    })) as { ok: boolean };
    if (!published.ok) throw new Error(`agent-exposure:publish failed: ${JSON.stringify(published)}`);
  }
  return { socket, deviceId: hello.device.id, agentId, name: profile.name };
}

/** 监听 agent socket 上的 task-claim:offer 推送。 */
export function watchOffers(agent: AcceptanceAgent): { readonly offers: Array<Record<string, unknown>> } {
  const offers: Array<Record<string, unknown>> = [];
  agent.socket.on(AGENT_EVENTS.taskClaim.offer, (payload: unknown) => {
    offers.push(payload as Record<string, unknown>);
  });
  return { offers };
}

/** 以公开 task:create 建 Task，再补齐 Management/Coordination fixture，供真实 broker + Agent Socket 协议验收。 */
export async function createClaimableTask(
  server: AcceptanceServer,
  owner: AcceptanceUser,
  input: {
    readonly key: string;
    readonly title: string;
    readonly claimPolicy?: 'open' | 'targeted';
    readonly targetAgentId?: string;
    readonly requiredCapabilities?: readonly string[];
    readonly requiredSkills?: readonly string[];
    readonly preferredSkills?: readonly string[];
  },
): Promise<{ readonly taskId: string; readonly managementRunId: string }> {
  const created = (await owner.emitWithAck(WEB_EVENTS.task.create, {
    teamId: owner.teamId,
    channelId: owner.channelId,
    title: input.title,
    description: input.title,
    ...(input.targetAgentId ? { assigneeId: input.targetAgentId } : {}),
  })) as { ok: boolean; task?: { id: string; revision: number } };
  if (!created.ok || !created.task) throw new Error(`task:create failed: ${JSON.stringify(created)}`);
  const managementRunId = `acceptance-run-${input.key}`;
  const now = Date.now();
  const db = server.openTeamDb();
  try {
    db.prepare(`INSERT INTO management_runs (
      id, team_id, channel_id, root_task_id, root_message_id, status,
      placement_policy_json, checkpoint_revision, budget_json, created_at, updated_at,
      management_phase, collaboration_mode
    ) VALUES (?, ?, ?, ?, ?, 'running', '{}', 0, '{}', ?, ?, 2, 'manager-orchestrated')`)
      .run(
        managementRunId,
        owner.teamId,
        owner.channelId,
        created.task.id,
        `acceptance-message-${input.key}`,
        now,
        now,
      );
    db.prepare(`INSERT INTO task_coordinations (
      task_id, team_id, management_run_id, root_task_id, node_kind, review_policy,
      claim_policy, required_capabilities_json, required_skills_json, preferred_skills_json,
      atomicity_hint, task_revision, attempt, max_attempts, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'root', 'human', ?, ?, ?, ?, 'decomposable', ?, 1, 1, ?, ?)`)
      .run(
        created.task.id,
        owner.teamId,
        managementRunId,
        created.task.id,
        input.claimPolicy ?? 'open',
        JSON.stringify(input.requiredCapabilities ?? []),
        JSON.stringify(input.requiredSkills ?? []),
        JSON.stringify(input.preferredSkills ?? []),
        created.task.revision,
        now,
        now,
      );
  } finally {
    db.close();
  }
  return { taskId: created.task.id, managementRunId };
}

export async function respondToOffer(
  agent: AcceptanceAgent,
  offerId: string,
  kind: 'accepted' | 'rejected' | 'needs_info' | 'counter_proposed',
  detail?: string,
): Promise<unknown> {
  return agent.socket.emitWithAck(AGENT_EVENTS.taskClaim.respond, {
    schemaVersion: 1,
    offerId,
    agentId: agent.agentId,
    kind,
    ...(detail ? { detail } : {}),
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// 断言辅助
// ─────────────────────────────────────────────────────────────────────────────

export async function eventually<T>(assertion: () => Promise<T> | T, attempts = 100, intervalMs = 25): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await assertion();
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export function queryAll<T>(db: BetterSqlite3Database, sql: string, ...params: unknown[]): T[] {
  return db.prepare(sql).all(...params) as T[];
}

export function queryCount(db: BetterSqlite3Database, sql: string, ...params: unknown[]): number {
  const row = db.prepare(sql).get(...params) as { n: number };
  return row.n;
}
