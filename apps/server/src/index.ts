import express from 'express';
import http from 'node:http';
import { existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import multer from 'multer';
import { Server as IOServer } from 'socket.io';
import { logger } from './log.js';
import { openDb, initGlobalDb, type Db, type GlobalDb } from './db.js';
import { AgentRegistry } from './registry.js';
import { DeviceRegistry } from './device-registry.js';
import { StorageManager } from './storage.js';
import { attachAgentNamespace, snapshotToDto, type DispatchFn } from './namespaces/agent.js';
import { AgentMetricsCollector } from './agent-metrics.js';
import { renderConnectCommand } from './connect-command.js';
import { startHeartbeatScanner } from './heartbeat-scanner.js';
import { ChannelService } from './channels.js';
import { runIntros } from './intro.js';
import { routeHumanMessage } from './routing.js';
import { attachArtifactRoutes } from './artifact-routes.js';
import { newId } from './ids.js';
import { generateToken, parseToken, verifyUserToken } from './auth.js';
import { hashPassword, verifyPassword } from './password.js';
import { generateInviteCode } from './invite.js';

export interface AppOptions { port?: number; dbPath?: string; agentToken?: string }
export interface AppHandle {
  http: http.Server;
  io: IOServer;
  db: Db;
  globalDb: GlobalDb;
  registry: AgentRegistry;
  channels: ChannelService;
  dispatch: DispatchFn;
  close: () => Promise<void>;
}

function deviceToDto(d: import('./device-registry.js').DeviceRuntime) {
  return {
    id: d.id,
    userId: d.userId,
    networkId: d.networkId,
    tailscaleIp: d.tailscaleIp,
    agentIds: Array.from(d.agents.keys()),
    lastSeenAt: d.lastSeenAt,
    status: d.status,
  };
}

function buildInviteCommand(code: string, serverUrl: string): string {
  const template = process.env.AGENT_BEAN_INVITE_COMMAND_TEMPLATE;
  if (template) {
    return template
      .replaceAll('{code}', code)
      .replaceAll('{serverUrl}', serverUrl);
  }

  const localAgentEntrypoint = resolve(process.cwd(), '../agent/src/bin.ts');
  if (existsSync(localAgentEntrypoint)) {
    return `npx --yes tsx ${localAgentEntrypoint} --invite ${code} --server-url ${serverUrl}`;
  }

  return `npx @agentbean/daemon@latest --invite ${code} --server-url ${serverUrl}`;
}

export async function buildApp(opts: AppOptions = {}): Promise<AppHandle> {
  const dbPath = opts.dbPath ?? process.env.DATABASE_PATH ?? './data/agentbean.db';
  const token = opts.agentToken ?? process.env.AGENT_BEAN_AGENT_TOKEN;
  if (!token) throw new Error('AGENT_BEAN_AGENT_TOKEN is required');
  const artifactDir = resolve(process.env.ARTIFACT_DIR ?? './data/artifacts');

  const db = openDb(dbPath);
  const globalDbPath = process.env.GLOBAL_DB_PATH ?? resolve('./data/global.db');
  const globalDb = initGlobalDb(globalDbPath);
  const registry = new AgentRegistry();
  const deviceRegistry = new DeviceRegistry();
  const storageManager = new StorageManager(process.env.STORAGE_BASE_DIR ?? './data/storage');
  const defaultNetworkId = 'default';
  storageManager.createSpace(defaultNetworkId);
  const space = storageManager.getSpace(defaultNetworkId);

  // Ensure system user exists for foreign key constraints
  try {
    globalDb.raw.prepare(`INSERT OR IGNORE INTO users (id, username, email, created_at, updated_at) VALUES (?, ?, null, ?, ?)`)
      .run('system', 'system', Date.now(), Date.now());
  } catch {}

  // Ensure 'default' user exists for legacy token compatibility
  try {
    globalDb.raw.prepare(`INSERT OR IGNORE INTO users (id, username, email, created_at, updated_at) VALUES (?, ?, null, ?, ?)`)
      .run('default', 'default', Date.now(), Date.now());
  } catch {}

  // Ensure default network exists in global DB
  if (!globalDb.networks.get(defaultNetworkId)) {
    globalDb.networks.create({
      id: defaultNetworkId,
      ownerId: 'system',
      name: 'Default Network',
      path: 'default',
      description: null,
      visibility: 'public',
      createdAt: Date.now(),
    });
  }

  // Ensure admin account exists after the default network so membership FK checks pass.
  {
    const existing = globalDb.users.getByName('admin');
    if (!existing) {
      const hash = await hashPassword('admin101');
      globalDb.users.create({ id: 'admin', username: 'admin', passwordHash: hash, role: 'admin', createdAt: Date.now() });
      logger.info('admin account created');
    }
    globalDb.networkMembers.add(defaultNetworkId, 'admin', 'owner');
  }
  const channels = new ChannelService({ storageManager, registry });
  channels.ensureDefault(defaultNetworkId);
  const metricsCollector = new AgentMetricsCollector();
  const inviteSessions = new Map<string, import('socket.io').Socket>();

  mkdirSync(artifactDir, { recursive: true });

  const app = express();
  app.disable('x-powered-by');
  app.use(express.json());
  app.get('/healthz', (_req, res) => res.json({ status: 'ok' }));

  const upload = multer({ dest: '/tmp/agentbean-uploads/', limits: { fileSize: 50 * 1024 * 1024 } });
  attachArtifactRoutes({ app, storageManager, upload, token });

  app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    logger.error({ err: err?.message, stack: err?.stack }, 'express error');
    res.status(500).json({ error: 'internal error' });
  });

  const server = http.createServer(app);
  const corsOrigin = process.env.CORS_ORIGIN ?? (process.env.NODE_ENV === 'production' ? false : 'http://localhost:3100');
  const io = new IOServer(server, { cors: { origin: corsOrigin } });

  const { dispatch } = attachAgentNamespace({ io, db, registry, deviceRegistry, token, globalDb, metricsCollector });

  const stopScanner = startHeartbeatScanner({
    registry, timeoutMs: 30_000, intervalMs: 5_000,
    onTimeout: (id) => {
      const rt = registry.snapshot(id);
      if (rt) io.of('/web').emit('agent:status', snapshotToDto(rt));
    },
  });

  const makePersistMessage = (sp: typeof space, netId: string) => (m: {
    id: string; channelId: string; senderKind: 'human' | 'agent' | 'system';
    senderId: string | null; body: string; createdAt: number; metaJson: string | null;
    artifactIds?: string[];
  }) => {
    sp.messages.append(m);
    if (m.artifactIds?.length) {
      sp.artifacts.bindMessageId(m.artifactIds, m.id);
    }
    const artifacts = sp.artifacts.listByMessage(m.id).map(a => ({
      id: a.id, filename: a.filename, mimeType: a.mimeType,
      sizeBytes: a.sizeBytes, createdAt: a.createdAt,
      downloadUrl: `/api/networks/${netId}/artifacts/${a.id}/download`,
      previewUrl: `/api/networks/${netId}/artifacts/${a.id}/preview`,
    }));
    io.of('/web').to(`channel:${m.channelId}`).emit('channel:message', {
      ...m, artifacts: artifacts.length > 0 ? artifacts : undefined,
    });
  };

  const socketNetworkMap = new Map<string, string>();

  const webToken = process.env.AGENT_BEAN_WEB_TOKEN ?? token;
  io.of('/web').use((socket, next) => {
    const clientToken = socket.handshake.auth.token ?? socket.handshake.query.token;
    if (socket.handshake.auth.invite === true) {
      socket.data.inviteAuth = true;
      return next();
    }
    if (!clientToken || typeof clientToken !== 'string') return next(new Error('unauthorized'));
    if (clientToken === webToken) {
      socket.data.legacyAuth = true;
      return next();
    }
    const parsed = verifyUserToken(clientToken, globalDb);
    if (!parsed) return next(new Error('unauthorized'));
    socket.data.userId = parsed.userId;
    socket.data.networkId = parsed.networkId;
    const user = globalDb.users.get(parsed.userId);
    if (user) socket.data.role = user.role;
    next();
  }).on('connection', (socket) => {
    logger.info({ sid: socket.id }, '/web client connected');
    socketNetworkMap.set(socket.id, socket.data.networkId ?? defaultNetworkId);

    socket.on('disconnect', () => {
      socketNetworkMap.delete(socket.id);
      for (const [sessionId, sessionSocket] of inviteSessions.entries()) {
        if (sessionSocket.id === socket.id) inviteSessions.delete(sessionId);
      }
    });

    socket.on('agents:subscribe', () => {
      const networkId = socketNetworkMap.get(socket.id) ?? defaultNetworkId;
      const filtered = registry.all().filter((a) =>
        a.networkId === networkId ||
        a.publishedNetworkIds.includes(networkId)
      );
      socket.emit('agents:snapshot', filtered.map(snapshotToDto));
    });

    socket.on('agent:metrics', (_payload: {}, ack?: (r: any) => void) => {
      try {
        const summaries = metricsCollector.all();
        ack?.({ ok: true, summaries });
      } catch (e: any) {
        ack?.({ ok: false, error: e.message ?? 'unknown' });
      }
    });

    socket.on('agents:discover', (_payload: {}, ack?: (r: any) => void) => {
      const daemonCount = io.of('/agent').sockets.size;
      if (daemonCount === 0) return ack?.({ ok: false, error: 'NO_DAEMON_CONNECTED' });
      io.of('/agent').emit('agents:discover');
      ack?.({ ok: true, daemonCount });
    });

    socket.on('device:scan', (payload: { deviceId: string }, ack?: (r: any) => void) => {
      try {
        const device = deviceRegistry.get(payload.deviceId);
        if (!device || device.status === 'offline') return ack?.({ ok: false, error: 'DEVICE_OFFLINE' });
        const agentSocket = io.of('/agent').sockets.get(device.socket.id);
        if (!agentSocket) return ack?.({ ok: false, error: 'SOCKET_NOT_FOUND' });
        agentSocket.emit('agents:discover');
        ack?.({ ok: true });
      } catch (e: any) {
        ack?.({ ok: false, error: e.message ?? 'unknown' });
      }
    });

    socket.on('devices:subscribe', () => {
      const nid = socketNetworkMap.get(socket.id) ?? defaultNetworkId;
      const devices = deviceRegistry.listByNetwork(nid).map(deviceToDto);
      socket.emit('devices:snapshot', devices);
    });

    socket.on('members:list', (_payload: {}, ack?: (r: any) => void) => {
      try {
        const networkId = socketNetworkMap.get(socket.id) ?? defaultNetworkId;
        const humans = globalDb.networkMembers.listByNetwork(networkId);
        const agents = registry.all().filter((a) =>
          a.networkId === networkId || a.publishedNetworkIds.includes(networkId)
        ).map(snapshotToDto);
        ack?.({ ok: true, humans, agents });
      } catch (e: any) {
        ack?.({ ok: false, error: e.message ?? 'unknown' });
      }
    });

    socket.on('device:get', (payload: { id: string }, ack?: (r: any) => void) => {
      try {
        const d = deviceRegistry.get(payload.id);
        if (!d) return ack?.({ ok: false, error: 'NOT_FOUND' });
        const nid = socketNetworkMap.get(socket.id) ?? defaultNetworkId;
        if (d.networkId !== nid && nid !== 'default') return ack?.({ ok: false, error: 'FORBIDDEN' });
        const agents = Array.from(d.agents.values());
        ack?.({ ok: true, device: { ...deviceToDto(d), agents } });
      } catch (e: any) {
        ack?.({ ok: false, error: e.message ?? 'unknown' });
      }
    });

    function getVisibleNetworks(userId?: string) {
      let networks = globalDb.networks.list().filter((n) => n.type !== 'private');
      if (userId) {
        const memberOf = new Set(globalDb.networkMembers.listByUser(userId).map((m) => m.networkId));
        networks = networks.filter((n) => n.visibility === 'public' || memberOf.has(n.id));
      }
      return networks;
    }

    socket.on('network:list', (_payload: {}, ack?: (r: any) => void) => {
      try {
        ack?.({ ok: true, networks: getVisibleNetworks(socket.data.userId as string | undefined) });
      } catch (e: any) {
        ack?.({ ok: false, error: e.message ?? 'unknown' });
      }
    });

    const RESERVED_PATHS = new Set(['login', 'signup', 'register', 'join', 'device-login', 'api', 'healthz']);

    function slugifyPath(name: string): string {
      return name.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 48);
    }

    function generateNetworkPath(name: string): string {
      let slug = slugifyPath(name);
      if (!slug || RESERVED_PATHS.has(slug)) slug = slug || 'network';
      let candidate = slug;
      let i = 1;
      while (globalDb.networks.getByPath(candidate)) {
        candidate = `${slug}-${i++}`;
      }
      return candidate;
    }

    socket.on('network:create', (payload: { name: string; path?: string; description?: string; visibility?: 'public' | 'private' }, ack?: (r: any) => void) => {
      try {
        logger.info({ payload, userId: socket.data.userId }, 'network:create');
        const name = payload.name.trim();
        if (!name) return ack?.({ ok: false, error: 'EMPTY_NAME' });
        const isPublic = payload.visibility === 'public' && socket.data.role === 'admin';
        const visibility = isPublic ? 'public' as const : 'private' as const;
        const type = isPublic ? 'public' as const : 'local' as const;
        const id = newId();
        const rawPath = payload.path?.trim().toLowerCase().replace(/[^a-z0-9-]/g, '') || '';
        if (rawPath && RESERVED_PATHS.has(rawPath)) return ack?.({ ok: false, error: 'RESERVED_PATH' });
        const path = rawPath && !globalDb.networks.getByPath(rawPath) ? rawPath : generateNetworkPath(rawPath || name);
        const network = globalDb.networks.create({
          id, ownerId: socket.data.userId ?? 'system', name, path,
          description: payload.description ?? null,
          visibility,
          type,
          createdAt: Date.now(),
        });
        if (socket.data.userId) {
          globalDb.networkMembers.add(id, socket.data.userId, 'owner');
        }
        storageManager.createSpace(id);
        channels.ensureDefault(id);
        ack?.({ ok: true, network });
        for (const s of io.of('/web').sockets.values()) {
          s.emit('networks:snapshot', getVisibleNetworks(s.data.userId as string | undefined));
        }
      } catch (e: any) {
        ack?.({ ok: false, error: e.message ?? 'unknown' });
      }
    });

    socket.on('network:switch', (payload: { networkId: string }, ack?: (r: any) => void) => {
      try {
        const network = globalDb.networks.get(payload.networkId);
        if (!network) return ack?.({ ok: false, error: 'NOT_FOUND' });
        const userId = socket.data.userId as string | undefined;
        if (userId && network.visibility !== 'public' && !globalDb.networkMembers.isMember(payload.networkId, userId)) {
          return ack?.({ ok: false, error: 'FORBIDDEN' });
        }
        socketNetworkMap.set(socket.id, payload.networkId);
        storageManager.getSpace(payload.networkId);
        ack?.({ ok: true, network });
      } catch (e: any) {
        ack?.({ ok: false, error: e.message ?? 'unknown' });
      }
    });

    socket.on('network:update', (payload: { name?: string }, ack?: (r: any) => void) => {
      try {
        const networkId = socketNetworkMap.get(socket.id) ?? defaultNetworkId;
        const userId = socket.data.userId as string | undefined;
        if (!userId) return ack?.({ ok: false, error: 'UNAUTHORIZED' });
        if (payload.name?.trim()) {
          globalDb.networks.updateName(networkId, payload.name.trim());
        }
        const updated = globalDb.networks.get(networkId);
        ack?.({ ok: true, network: updated });
        for (const s of io.of('/web').sockets.values()) {
          s.emit('networks:snapshot', getVisibleNetworks(s.data.userId as string | undefined));
        }
      } catch (e: any) {
        ack?.({ ok: false, error: e.message ?? 'unknown' });
      }
    });

    socket.on('channels:subscribe', () => {
      const networkId = socketNetworkMap.get(socket.id) ?? defaultNetworkId;
      const userId = socket.data.userId as string | undefined;
      const list = userId ? channels.listForUser(networkId, userId) : channels.list(networkId);
      socket.emit('channels:snapshot', list);
    });

    socket.on('channel:join', (payload: { channelId: string }) => {
      const networkId = socketNetworkMap.get(socket.id) ?? defaultNetworkId;
      const ch = channels.get(networkId, payload.channelId);
      if (!ch) {
        socket.emit('error', { message: 'CHANNEL_NOT_FOUND' });
        return;
      }
      socket.join(`channel:${payload.channelId}`);
      const sp = storageManager.getSpace(networkId);
      const history = sp.messages.listByChannel(payload.channelId, 200);
      const messagesWithArtifacts = history.map(m => {
        const artifacts = sp.artifacts.listByMessage(m.id).map(a => ({
          id: a.id, filename: a.filename, mimeType: a.mimeType,
          sizeBytes: a.sizeBytes, createdAt: a.createdAt,
          downloadUrl: `/api/networks/${networkId}/artifacts/${a.id}/download`,
          previewUrl: `/api/networks/${networkId}/artifacts/${a.id}/preview`,
        }));
        return { ...m, artifacts: artifacts.length > 0 ? artifacts : undefined };
      });
      socket.emit('channel:history', { channelId: payload.channelId, messages: messagesWithArtifacts });
    });

    socket.on('channel:create', async (payload: { name?: string; agentIds: string[]; userIds?: string[]; visibility?: 'public' | 'private' }, ack?: (r: any) => void) => {
      try {
        const networkId = socketNetworkMap.get(socket.id) ?? defaultNetworkId;
        const userId = socket.data.userId as string | undefined;
        const ch = channels.create(networkId, {
          name: payload.name ?? '',
          agentIds: payload.agentIds,
          userIds: payload.userIds,
          visibility: payload.visibility,
          createdBy: userId,
        });
        ack?.({ ok: true, channel: ch });
        io.of('/web').emit('channels:snapshot', channels.list(networkId)); // broadcast full list, client filters
        const members = channels.membersOf(networkId, ch.id);
        const sp = storageManager.getSpace(networkId);
        const persist = makePersistMessage(sp, networkId);
        await runIntros({
          channel: ch,
          members,
          dispatch: (req) => dispatch({ agentId: req.agentId, channelId: req.channelId, prompt: req.prompt, requestId: req.requestId }),
          onMessage: persist,
        });
      } catch (e: any) {
        ack?.({ ok: false, error: e.message ?? 'unknown' });
      }
    });

    socket.on('message:send', async (
      payload: { channelId: string; body: string; clientMsgId: string },
      ack?: (r: any) => void,
    ) => {
      const networkId = socketNetworkMap.get(socket.id) ?? defaultNetworkId;
      const sp = storageManager.getSpace(networkId);
      const persist = makePersistMessage(sp, networkId);

      const body = (payload?.body ?? '').trim();
      if (!body) return ack?.({ ok: false, error: 'EMPTY' });
      const ch = channels.get(networkId, payload.channelId);
      if (!ch) return ack?.({ ok: false, error: 'NO_CHANNEL' });

      const humanMsg = {
        id: newId(), channelId: ch.id, senderKind: 'human' as const, senderId: (socket.data.userId as string) ?? null,
        body, createdAt: Date.now(),
        metaJson: JSON.stringify({ clientMsgId: payload.clientMsgId }),
      };
      persist(humanMsg);
      ack?.({ ok: true, id: humanMsg.id });

      const members = channels.membersOf(networkId, ch.id);

      const route = routeHumanMessage({ body, members });

      if (route.reason === 'NO_ONLINE') {
        persist({
          id: newId(), channelId: ch.id, senderKind: 'system', senderId: null,
          body: '当前没有在线 Agent 可响应,消息已保存。',
          createdAt: Date.now(), metaJson: JSON.stringify({ kind: 'no-online-agent' }),
        });
        return;
      }

      const recipient = route.targets[0]!;
      const reqId = newId();
      const reply = await dispatch({
        agentId: recipient.id,
        channelId: ch.id,
        prompt: body,
        requestId: reqId,
      });
      if (reply.ok && reply.body) {
        const artifactIds = reply.artifactIds;
        persist({
          id: newId(), channelId: ch.id, senderKind: 'agent', senderId: recipient.id,
          body: reply.body, createdAt: Date.now(),
          metaJson: JSON.stringify({ inReplyTo: humanMsg.id, requestId: reqId }),
          artifactIds: artifactIds?.length ? artifactIds : undefined,
        });
      } else {
        persist({
          id: newId(), channelId: ch.id, senderKind: 'system', senderId: null,
          body: `${recipient.name} 处理失败: ${reply.error ?? 'unknown'}`,
          createdAt: Date.now(), metaJson: JSON.stringify({ kind: 'reply-fail', agentId: recipient.id }),
        });
      }
    });

    socket.on('channel:add-member', (payload: { channelId: string; userId: string }, ack?: (r: any) => void) => {
      try {
        const networkId = socketNetworkMap.get(socket.id) ?? defaultNetworkId;
        const ch = channels.get(networkId, payload.channelId);
        if (!ch) return ack?.({ ok: false, error: 'NOT_FOUND' });
        channels.addUserMember(networkId, payload.channelId, payload.userId);
        ack?.({ ok: true });
      } catch (e: any) {
        ack?.({ ok: false, error: e.message ?? 'unknown' });
      }
    });

    socket.on('channel:remove-member', (payload: { channelId: string; userId: string }, ack?: (r: any) => void) => {
      try {
        const networkId = socketNetworkMap.get(socket.id) ?? defaultNetworkId;
        const ch = channels.get(networkId, payload.channelId);
        if (!ch) return ack?.({ ok: false, error: 'NOT_FOUND' });
        channels.removeUserMember(networkId, payload.channelId, payload.userId);
        ack?.({ ok: true });
      } catch (e: any) {
        ack?.({ ok: false, error: e.message ?? 'unknown' });
      }
    });

    socket.on('agent:create', (payload: { name: string; role?: string; adapterKind: string; visibility?: 'public' | 'private'; networkId?: string; category?: string; ownerId?: string; command?: string; args?: string[]; cwd?: string }, ack?: (r: any) => void) => {
      try {
        const name = payload.name.trim();
        if (!name) return ack?.({ ok: false, error: 'EMPTY_NAME' });
        const targetNetworkId = payload.networkId ?? socket.data.networkId ?? socketNetworkMap.get(socket.id) ?? defaultNetworkId;
        const userId = socket.data.userId as string | undefined;
        const network = globalDb.networks.get(targetNetworkId);
        if (userId && network?.visibility !== 'public' && !globalDb.networkMembers.isMember(targetNetworkId, userId)) {
          return ack?.({ ok: false, error: 'FORBIDDEN' });
        }
        const id = newId();
        const now = Date.now();
        const row = {
          id, name, role: payload.role ?? null,
          adapterKind: payload.adapterKind as import('./db.js').AdapterKind,
          deviceId: null,
          networkId: targetNetworkId,
          visibility: payload.visibility ?? 'public',
          category: (payload.category as import('./db.js').AgentCategory) ?? 'executor-hosted',
          firstSeenAt: now, lastSeenAt: now, lastError: null,
          ownerId: payload.ownerId ?? userId ?? null,
          command: payload.command ?? null,
          args: payload.args ? JSON.stringify(payload.args) : null,
          cwd: payload.cwd ?? null,
        };
        db.agents.create(row);
        ack?.({ ok: true, agent: row });
        io.of('/web').emit('agents:snapshot', registry.all().map(snapshotToDto));
      } catch (e: any) {
        ack?.({ ok: false, error: e.message ?? 'unknown' });
      }
    });

    socket.on('agent:update', (payload: { id: string; visibility?: 'public' | 'private'; networkId?: string }, ack?: (r: any) => void) => {
      try {
        const existing = db.agents.get(payload.id);
        if (!existing) return ack?.({ ok: false, error: 'NOT_FOUND' });

        let changed = false;
        let visibility = existing.visibility;
        let networkId = existing.networkId;

        if (payload.visibility !== undefined && payload.visibility !== existing.visibility) {
          db.agents.updateVisibility(payload.id, payload.visibility);
          registry.updateVisibility(payload.id, payload.visibility);
          visibility = payload.visibility;
          changed = true;
        }

        if (payload.networkId !== undefined && payload.networkId !== existing.networkId) {
          db.agents.updateNetworkId(payload.id, payload.networkId);
          registry.updateNetworkId(payload.id, payload.networkId);
          networkId = payload.networkId;
          changed = true;
        }

        if (changed) {
          const rt = registry.snapshot(payload.id);
          if (rt) {
            io.of('/web').emit('agent:status', snapshotToDto(rt));
          } else {
            io.of('/web').emit('agent:status', {
              id: payload.id,
              name: existing.name,
              role: existing.role ?? '',
              adapterKind: existing.adapterKind,
              status: 'offline',
              lastSeenAt: existing.lastSeenAt,
              visibility,
              networkId,
              connectCommand: renderConnectCommand({ adapterKind: existing.adapterKind }),
            });
          }
        }

        ack?.({ ok: true });
      } catch (e: any) {
        ack?.({ ok: false, error: e.message ?? 'unknown' });
      }
    });

    socket.on('agent:publish', (payload: { agentId: string; networkId: string }, ack?: (r: any) => void) => {
      try {
        const userId = socket.data.userId as string | undefined;
        if (!userId) return ack?.({ ok: false, error: 'UNAUTHORIZED' });
        const rt = registry.snapshot(payload.agentId);
        if (!rt) return ack?.({ ok: false, error: 'NOT_FOUND' });
        if (rt.ownerId && rt.ownerId !== userId) return ack?.({ ok: false, error: 'FORBIDDEN' });
        if (!globalDb.networkMembers.isMember(payload.networkId, userId)) {
          return ack?.({ ok: false, error: 'NOT_NETWORK_MEMBER' });
        }
        globalDb.agentPublishes.publish(payload.agentId, payload.networkId, userId);
        const publishes = globalDb.agentPublishes.listByAgent(payload.agentId);
        registry.updatePublishedNetworks(payload.agentId, publishes.map((p: any) => p.networkId));
        const updated = registry.snapshot(payload.agentId);
        if (updated) io.of('/web').emit('agent:status', snapshotToDto(updated));
        ack?.({ ok: true });
      } catch (e: any) {
        ack?.({ ok: false, error: e.message ?? 'unknown' });
      }
    });

    socket.on('agent:unpublish', (payload: { agentId: string; networkId: string }, ack?: (r: any) => void) => {
      try {
        const userId = socket.data.userId as string | undefined;
        if (!userId) return ack?.({ ok: false, error: 'UNAUTHORIZED' });
        const rt = registry.snapshot(payload.agentId);
        if (!rt) return ack?.({ ok: false, error: 'NOT_FOUND' });
        if (rt.ownerId && rt.ownerId !== userId) return ack?.({ ok: false, error: 'FORBIDDEN' });
        globalDb.agentPublishes.unpublish(payload.agentId, payload.networkId);
        const publishes = globalDb.agentPublishes.listByAgent(payload.agentId);
        registry.updatePublishedNetworks(payload.agentId, publishes.map((p: any) => p.networkId));
        const updated = registry.snapshot(payload.agentId);
        if (updated) io.of('/web').emit('agent:status', snapshotToDto(updated));
        ack?.({ ok: true });
      } catch (e: any) {
        ack?.({ ok: false, error: e.message ?? 'unknown' });
      }
    });

    socket.on('auth:invite:validate', (payload: { code: string }, ack?: (r: any) => void) => {
      try {
        const invite = globalDb.invites.getByCode(payload.code);
        if (!invite) return ack?.({ ok: false, error: 'INVALID_CODE' });
        if (invite.usedAt) return ack?.({ ok: false, error: 'ALREADY_USED' });
        if (invite.expiresAt && invite.expiresAt < Date.now()) return ack?.({ ok: false, error: 'EXPIRED' });

        const webUrl = process.env.WEB_URL ?? 'http://localhost:3100';
        if (invite.purpose === 'device') {
          ack?.({ ok: true, sessionId: null, registerUrl: `${webUrl}/device-login/${encodeURIComponent(payload.code)}` });
        } else {
          const sessionId = newId();
          inviteSessions.set(sessionId, socket);
          ack?.({ ok: true, sessionId, registerUrl: `${webUrl}/join/${sessionId}?code=${encodeURIComponent(payload.code)}` });
        }
      } catch (e: any) {
        ack?.({ ok: false, error: e.message ?? 'unknown' });
      }
    });

    socket.on('auth:register', async (
      payload: { username: string; password: string; email?: string; inviteToken?: string; sessionId?: string },
      ack?: (r: any) => void,
    ) => {
      try {
        const username = payload.username.trim();
        const email = payload.email?.trim() || null;
        if (!username || username.length < 2) return ack?.({ ok: false, error: 'USERNAME_TOO_SHORT' });
        if (!payload.password || payload.password.length < 6) return ack?.({ ok: false, error: 'PASSWORD_TOO_SHORT' });
        if (globalDb.users.getByName(username)) return ack?.({ ok: false, error: 'USERNAME_TAKEN' });
        if (email && globalDb.users.getByEmail(email)) return ack?.({ ok: false, error: 'EMAIL_TAKEN' });

        const invite = payload.inviteToken ? globalDb.invites.getByCode(payload.inviteToken) : null;
        if (payload.inviteToken) {
          if (!invite) return ack?.({ ok: false, error: 'INVALID_CODE' });
          if (invite.maxUses === null) {
            // Single-use invite (legacy)
            if (invite.usedAt) return ack?.({ ok: false, error: 'ALREADY_USED' });
          } else {
            // Multi-use join link
            if (invite.usesCount >= invite.maxUses) return ack?.({ ok: false, error: 'MAX_USES_REACHED' });
          }
          if (invite.expiresAt && invite.expiresAt < Date.now()) return ack?.({ ok: false, error: 'EXPIRED' });
        }

        const userId = newId();
        const now = Date.now();
        const passwordHash = await hashPassword(payload.password);
        const user = globalDb.users.create({ id: userId, username, email, passwordHash, createdAt: now });
        const privatePath = generateNetworkPath(username);
        const privateNetwork = globalDb.networks.create({
          id: newId(),
          ownerId: userId,
          name: `${username}-private`,
          path: privatePath,
          visibility: 'private',
          type: 'private',
          createdAt: now,
        });
        globalDb.networkMembers.add(privateNetwork.id, userId, 'owner');
        storageManager.createSpace(privateNetwork.id);
        channels.ensureDefault(privateNetwork.id);

        // Auto-join all public networks so the user can see the public mesh
        const publicNetworks = globalDb.networks.list().filter(n => n.type === 'public');
        for (const net of publicNetworks) {
          if (!globalDb.networkMembers.isMember(net.id, userId)) {
            globalDb.networkMembers.add(net.id, userId, 'member');
          }
        }

        if (invite?.networkId) {
          globalDb.networkMembers.add(invite.networkId, userId, 'member');
        }
        if (invite) {
          if (invite.maxUses === null) {
            globalDb.invites.incrementUses(invite.code);
          } else {
            globalDb.invites.incrementUses(invite.code);
            const updated = globalDb.invites.getByCode(invite.code);
            if (updated && updated.maxUses !== null && updated.usesCount >= updated.maxUses) {
              globalDb.invites.markUsed(invite.code);
            }
          }
        }

        const userToken = generateToken(userId, privateNetwork.id);
        socket.data.userId = userId;
        socket.data.networkId = privateNetwork.id;
        socket.data.role = user.role;
        socketNetworkMap.set(socket.id, privateNetwork.id);

        ack?.({ ok: true, userId, username: user.username, email: user.email, role: user.role, token: userToken, networkId: privateNetwork.id, networkPath: privateNetwork.path, network: privateNetwork });

        const sessionSocket = payload.sessionId ? inviteSessions.get(payload.sessionId) : undefined;
        if (payload.sessionId && sessionSocket) {
          sessionSocket.emit('auth:token:deliver', { sessionId: payload.sessionId, token: userToken, userId, networkId: privateNetwork.id });
          inviteSessions.delete(payload.sessionId);
        }
      } catch (e: any) {
        ack?.({ ok: false, error: e.message ?? 'unknown' });
      }
    });

    socket.on('auth:login', async (
      payload: { username: string; password: string; joinCode?: string },
      ack?: (r: any) => void,
    ) => {
      try {
        const user = globalDb.users.getByName(payload.username);
        if (!user || !user.passwordHash) return ack?.({ ok: false, error: 'INVALID_CREDENTIALS' });
        const ok = await verifyPassword(payload.password, user.passwordHash);
        if (!ok) return ack?.({ ok: false, error: 'INVALID_CREDENTIALS' });

        // Handle join link — add user to the invite's network
        let joinedNetworkId: string | undefined;
        if (payload.joinCode) {
          const invite = globalDb.invites.getByCode(payload.joinCode);
          if (invite && !invite.usedAt && (!invite.expiresAt || invite.expiresAt > Date.now())) {
            if (invite.networkId && !globalDb.networkMembers.isMember(invite.networkId, user.id)) {
              globalDb.networkMembers.add(invite.networkId, user.id, 'member');
              joinedNetworkId = invite.networkId;
            }
            globalDb.invites.incrementUses(invite.code);
            const updated = globalDb.invites.getByCode(invite.code);
            if (updated && updated.maxUses !== null && updated.usesCount >= updated.maxUses) {
              globalDb.invites.markUsed(invite.code);
            }
          }
        }

        // Ensure user is a member of all public networks
        const publicNetworks = globalDb.networks.list().filter(n => n.type === 'public');
        for (const net of publicNetworks) {
          if (!globalDb.networkMembers.isMember(net.id, user.id)) {
            globalDb.networkMembers.add(net.id, user.id, 'member');
          }
        }

        const members = globalDb.networkMembers.listByUser(user.id);
        const primaryNetwork = joinedNetworkId ?? members[0]?.networkId ?? defaultNetworkId;
        const primaryNetRow = globalDb.networks.get(primaryNetwork);
        const userToken = generateToken(user.id, primaryNetwork);
        socket.data.userId = user.id;
        socket.data.networkId = primaryNetwork;
        socket.data.role = user.role;
        socketNetworkMap.set(socket.id, primaryNetwork);
        ack?.({ ok: true, userId: user.id, username: user.username, email: user.email, role: user.role, token: userToken, networkId: primaryNetwork, networkPath: primaryNetRow?.path ?? 'default' });
      } catch (e: any) {
        ack?.({ ok: false, error: e.message ?? 'unknown' });
      }
    });

    socket.on('auth:whoami', (_payload: {}, ack?: (r: any) => void) => {
      try {
        const userId = socket.data.userId ?? parseToken(String(socket.handshake.auth.token ?? ''))?.userId;
        if (!userId) return ack?.({ ok: false, error: 'NOT_AUTHENTICATED' });
        const user = globalDb.users.get(userId);
        if (!user) return ack?.({ ok: false, error: 'NOT_AUTHENTICATED' });
        ack?.({ ok: true, user: { id: user.id, username: user.username, email: user.email, role: user.role } });
      } catch (e: any) {
        ack?.({ ok: false, error: e.message ?? 'unknown' });
      }
    });

    socket.on('auth:device-login', async (payload: { inviteCode: string; username: string; password: string }, ack?: (r: any) => void) => {
      try {
        const invite = globalDb.invites.getByCode(payload.inviteCode);
        if (!invite || invite.purpose !== 'device') return ack?.({ ok: false, error: 'INVALID_INVITE' });
        if (invite.usedAt) return ack?.({ ok: false, error: 'INVITE_ALREADY_USED' });
        if (invite.expiresAt && Date.now() > invite.expiresAt) return ack?.({ ok: false, error: 'INVITE_EXPIRED' });
        const user = globalDb.users.getByName(payload.username);
        if (!user || !user.passwordHash) return ack?.({ ok: false, error: 'INVALID_CREDENTIALS' });
        const ok = await verifyPassword(payload.password, user.passwordHash);
        if (!ok) return ack?.({ ok: false, error: 'INVALID_CREDENTIALS' });
        const networkId = invite.networkId ?? defaultNetworkId;
        const userToken = generateToken(user.id, networkId);
        globalDb.invites.markUsed(invite.code);
        socket.data.userId = user.id;
        socket.data.networkId = networkId;
        socket.data.role = user.role;
        socketNetworkMap.set(socket.id, networkId);
        const devNetRow = globalDb.networks.get(networkId);
        ack?.({ ok: true, token: userToken, networkId, networkPath: devNetRow?.path ?? 'default', userId: user.id, username: user.username, role: user.role });
      } catch (e: any) {
        ack?.({ ok: false, error: e.message ?? 'unknown' });
      }
    });

    socket.on('auth:change-password', async (payload: { currentPassword: string; newPassword: string }, ack?: (r: any) => void) => {
      try {
        const userId = socket.data.userId;
        if (!userId) return ack?.({ ok: false, error: 'UNAUTHORIZED' });
        const user = globalDb.users.get(userId);
        if (!user?.passwordHash) return ack?.({ ok: false, error: 'NO_PASSWORD' });
        const ok = await verifyPassword(payload.currentPassword, user.passwordHash);
        if (!ok) return ack?.({ ok: false, error: 'WRONG_PASSWORD' });
        const newHash = await hashPassword(payload.newPassword);
        globalDb.raw.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?').run(newHash, Date.now(), user.id);
        ack?.({ ok: true });
      } catch (e: any) {
        ack?.({ ok: false, error: e.message ?? 'unknown' });
      }
    });

    socket.on('invite:create', (payload: { networkId?: string; purpose?: 'user' | 'device' }, ack?: (r: any) => void) => {
      try {
        const userId = socket.data.userId as string | undefined ?? (socket.data.legacyAuth ? 'system' : undefined);
        if (!userId) return ack?.({ ok: false, error: 'NOT_AUTHENTICATED' });
        const networkId = payload.networkId ?? socketNetworkMap.get(socket.id) ?? null;
        if (networkId) {
          const network = globalDb.networks.get(networkId);
          if (!network) return ack?.({ ok: false, error: 'NETWORK_NOT_FOUND' });
          if (network.visibility !== 'public' && !globalDb.networkMembers.isMember(networkId, userId)) {
            return ack?.({ ok: false, error: 'FORBIDDEN' });
          }
        }

        const purpose = payload.purpose ?? 'device';
        const code = generateInviteCode();
        const invite = globalDb.invites.create({
          id: newId(),
          code,
          createdBy: userId,
          networkId,
          purpose,
          expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
        });
        const serverUrl = process.env.AGENT_BEAN_PUBLIC_SERVER_URL ?? 'http://localhost:4000';
        ack?.({
          ok: true,
          invite: {
            code,
            expiresAt: invite.expiresAt,
            command: buildInviteCommand(code, serverUrl),
            purpose,
          },
        });
      } catch (e: any) {
        ack?.({ ok: false, error: e.message ?? 'unknown' });
      }
    });

    // ── Join Link Management ──────────────────────────────────────

    socket.on('join:create', (payload: { maxUses?: number; expiresAt?: number }, ack?: (r: any) => void) => {
      try {
        const userId = socket.data.userId as string | undefined;
        if (!userId) return ack?.({ ok: false, error: 'NOT_AUTHENTICATED' });
        const networkId = socketNetworkMap.get(socket.id) ?? defaultNetworkId;
        const network = globalDb.networks.get(networkId);
        if (!network) return ack?.({ ok: false, error: 'NETWORK_NOT_FOUND' });
        const isOwner = network.ownerId === userId;
        const isMember = globalDb.networkMembers.isMember(networkId, userId);
        if (!isOwner && !isMember && network.visibility !== 'public') return ack?.({ ok: false, error: 'FORBIDDEN' });

        const code = generateInviteCode(12);
        const invite = globalDb.invites.create({
          id: newId(),
          code,
          createdBy: userId,
          networkId,
          purpose: 'user',
          expiresAt: payload.expiresAt ?? null,
          maxUses: payload.maxUses ?? 1,
        });
        const webUrl = process.env.WEB_URL ?? 'http://localhost:3100';
        ack?.({
          ok: true,
          link: {
            id: invite.id,
            code,
            url: `${webUrl}/join/${code}`,
            maxUses: invite.maxUses,
            usesCount: 0,
            expiresAt: invite.expiresAt,
            createdAt: invite.createdAt,
          },
        });
      } catch (e: any) {
        ack?.({ ok: false, error: e.message ?? 'unknown' });
      }
    });

    socket.on('join:list', (_payload: {}, ack?: (r: any) => void) => {
      try {
        const userId = socket.data.userId as string | undefined;
        if (!userId) return ack?.({ ok: false, error: 'NOT_AUTHENTICATED' });
        const networkId = socketNetworkMap.get(socket.id) ?? defaultNetworkId;
        const links = globalDb.invites.listByNetwork(networkId)
          .filter((inv) => inv.purpose === 'user' && !inv.usedAt && (!inv.expiresAt || inv.expiresAt > Date.now()))
          .map((inv) => ({
            id: inv.id,
            code: inv.code,
            url: `${process.env.WEB_URL ?? 'http://localhost:3100'}/join/${inv.code}`,
            maxUses: inv.maxUses,
            usesCount: inv.usesCount,
            expiresAt: inv.expiresAt,
            createdAt: inv.createdAt,
            usedAt: inv.usedAt,
          }));
        ack?.({ ok: true, links });
      } catch (e: any) {
        ack?.({ ok: false, error: e.message ?? 'unknown' });
      }
    });

    socket.on('join:revoke', (payload: { code: string }, ack?: (r: any) => void) => {
      try {
        const userId = socket.data.userId as string | undefined;
        if (!userId) return ack?.({ ok: false, error: 'NOT_AUTHENTICATED' });
        const invite = globalDb.invites.getByCode(payload.code);
        if (!invite || invite.purpose !== 'user') return ack?.({ ok: false, error: 'NOT_FOUND' });
        const networkId = socketNetworkMap.get(socket.id) ?? defaultNetworkId;
        if (invite.networkId !== networkId) return ack?.({ ok: false, error: 'FORBIDDEN' });
        globalDb.invites.revoke(payload.code);
        ack?.({ ok: true });
      } catch (e: any) {
        ack?.({ ok: false, error: e.message ?? 'unknown' });
      }
    });

    socket.on('auth:join:validate', (payload: { code: string }, ack?: (r: any) => void) => {
      try {
        const invite = globalDb.invites.getByCode(payload.code);
        if (!invite || invite.purpose !== 'user') return ack?.({ ok: false, error: 'INVALID_CODE' });
        if (invite.usedAt) return ack?.({ ok: false, error: 'ALREADY_USED' });
        if (invite.expiresAt && invite.expiresAt < Date.now()) return ack?.({ ok: false, error: 'EXPIRED' });
        if (invite.maxUses !== null && invite.usesCount >= invite.maxUses) return ack?.({ ok: false, error: 'MAX_USES_REACHED' });
        const network = invite.networkId ? globalDb.networks.get(invite.networkId) : null;
        ack?.({
          ok: true,
          networkName: network?.name ?? '未知网络',
          expiresAt: invite.expiresAt,
        });
      } catch (e: any) {
        ack?.({ ok: false, error: e.message ?? 'unknown' });
      }
    });

    // ── Admin Events ─────────────────────────────────────────────
    const requireAdmin = (ack?: (r: any) => void): string | null => {
      const userId = socket.data.userId as string | undefined;
      if (!userId) { ack?.({ ok: false, error: 'NOT_AUTHENTICATED' }); return null; }
      const user = globalDb.users.get(userId);
      if (!user || user.role !== 'admin') { ack?.({ ok: false, error: 'FORBIDDEN' }); return null; }
      return userId;
    };

    socket.on('admin:list-users', (_p: {}, ack?: (r: any) => void) => {
      if (!requireAdmin(ack)) return;
      ack?.({ ok: true, users: globalDb.users.listAll().map(u => ({ id: u.id, username: u.username, email: u.email, role: u.role, createdAt: u.createdAt })) });
    });

    socket.on('admin:delete-user', (payload: { userId: string }, ack?: (r: any) => void) => {
      if (!requireAdmin(ack)) return;
      if (payload.userId === 'system' || payload.userId === 'admin') return ack?.({ ok: false, error: 'CANNOT_DELETE_SYSTEM_USER' });
      globalDb.users.delete(payload.userId);
      ack?.({ ok: true });
    });

    socket.on('admin:list-networks', (_p: {}, ack?: (r: any) => void) => {
      if (!requireAdmin(ack)) return;
      const nets = globalDb.networks.list().map((n) => ({
        ...n,
        members: globalDb.networkMembers.listByNetwork(n.id),
      }));
      ack?.({ ok: true, networks: nets });
    });

    socket.on('admin:delete-network', (payload: { networkId: string }, ack?: (r: any) => void) => {
      if (!requireAdmin(ack)) return;
      if (payload.networkId === 'default') return ack?.({ ok: false, error: 'CANNOT_DELETE_DEFAULT_NETWORK' });
      globalDb.raw.prepare('DELETE FROM networks WHERE id = ?').run(payload.networkId);
      ack?.({ ok: true });
    });

    socket.on('admin:list-devices', (_p: {}, ack?: (r: any) => void) => {
      if (!requireAdmin(ack)) return;
      const devices = deviceRegistry.all().map(d => ({ id: d.id, status: d.status, agentCount: d.agents.size, lastSeenAt: d.lastSeenAt, networkId: d.networkId }));
      ack?.({ ok: true, devices });
    });

    socket.on('admin:list-agents', (_p: {}, ack?: (r: any) => void) => {
      if (!requireAdmin(ack)) return;
      ack?.({ ok: true, agents: registry.all().map(snapshotToDto) });
    });

    socket.on('admin:delete-agent', (payload: { agentId: string }, ack?: (r: any) => void) => {
      if (!requireAdmin(ack)) return;
      registry.markOffline(payload.agentId, 'admin-delete');
      ack?.({ ok: true });
    });

  });

  if (opts.port !== undefined) {
    server.listen(opts.port, () => logger.info({ port: opts.port }, 'server listening'));
  }

  return {
    http: server, io, db, globalDb, registry, channels, dispatch,
    async close() {
      stopScanner();
      await new Promise<void>((resolve) => io.close(() => resolve()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
      db.close();
      globalDb.close();
    },
  };
}

const isEntry = process.argv[1]?.endsWith('index.js') || process.argv[1]?.endsWith('index.ts') || import.meta.url === `file://${process.argv[1]}`;
if (isEntry) {
  const port = Number(process.env.PORT ?? 4000);
  buildApp({ port });
}
