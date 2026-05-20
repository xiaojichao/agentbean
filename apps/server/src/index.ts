import express from 'express';
import http from 'node:http';
import { existsSync, mkdirSync, statSync } from 'node:fs';
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

export interface AppOptions { port?: number; dbPath?: string; globalDbPath?: string; agentToken?: string }
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

function buildInviteCommand(code: string, serverUrl: string): string {
  const template = process.env.AGENT_BEAN_INVITE_COMMAND_TEMPLATE;
  if (template) {
    return template
      .replaceAll('{code}', code)
      .replaceAll('{serverUrl}', serverUrl);
  }

  const localAgentEntrypoint = resolve(process.cwd(), '../daemon/src/bin.ts');
  if (existsSync(localAgentEntrypoint)) {
    return `npx --yes tsx ${localAgentEntrypoint} --invite ${code} --server-url ${serverUrl}`;
  }

  return `npx @agentbean/daemon@latest --invite ${code} --server-url ${serverUrl}`;
}

function isTeamAgent(agent: { category?: string | null; source?: string | null }): boolean {
  return agent.category === 'agentos-hosted' || agent.source === 'custom';
}

function normalizeKind(kind?: string | null): string {
  const normalized = (kind ?? '').trim().toLowerCase().replace(/[_\s]+/g, '-');
  if (normalized === 'kimi-cli' || normalized === 'kimi') return 'kimi-cli';
  if (normalized === 'claude' || normalized === 'claude-code') return 'claude-code';
  if (normalized === 'codex' || normalized === 'codex-cli') return 'codex';
  return normalized;
}

function runtimeMatchesAgent(runtime: { adapterKind?: string | null; command?: string | null; installed?: boolean }, agent: { adapterKind?: string | null; command?: string | null }): boolean {
  if (!runtime.installed) return false;
  const runtimeCommand = runtime.command?.trim();
  const agentCommand = agent.command?.trim();
  if (runtimeCommand && agentCommand && runtimeCommand === agentCommand) return true;
  const runtimeKind = normalizeKind(runtime.adapterKind);
  const agentKind = normalizeKind(agent.adapterKind);
  if (!runtimeKind || !agentKind) return false;
  if (runtimeKind === agentKind) return true;
  return runtimeKind === 'kimi-cli' && agentKind === 'codex' && Boolean(agentCommand?.includes('kimi-cli'));
}

function isOnlineStatus(status?: string | null): boolean {
  return status === 'online' || status === 'busy';
}

function isVirtualDeviceId(id?: string | null): boolean {
  return Boolean(id?.startsWith('virtual-'));
}

function projectDirectoryExists(cwd?: string | null): boolean {
  if (!cwd?.trim()) return false;
  const normalized = cwd.trim().replace(/^~(?=$|\/)/, process.env.HOME ?? '');
  try {
    return statSync(normalized).isDirectory();
  } catch {
    return false;
  }
}

function resolveCorsOrigin(): string | false {
  return process.env.CORS_ORIGIN ?? (process.env.NODE_ENV === 'production' ? false : 'http://localhost:3100');
}

function attachRestCors(app: express.Express, origin: string | false): void {
  app.use((req, res, next) => {
    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    }
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  });
}

function isRecentlySeen(lastSeenAt?: number | null): boolean {
  if (!lastSeenAt) return false;
  return Date.now() - lastSeenAt < 45_000;
}

// Fixed data directory relative to this source file (not cwd)
const DATA_DIR = resolve(import.meta.dirname, '../data');

export async function buildApp(opts: AppOptions = {}): Promise<AppHandle> {
  const dbPath = opts.dbPath ?? process.env.DATABASE_PATH ?? resolve(DATA_DIR, 'agentbean.db');
  const token = opts.agentToken ?? process.env.AGENT_BEAN_AGENT_TOKEN;
  if (!token) throw new Error('AGENT_BEAN_AGENT_TOKEN is required');
  const artifactDir = resolve(process.env.ARTIFACT_DIR ?? resolve(DATA_DIR, 'artifacts'));

  const db = openDb(dbPath);
  const globalDbPath = opts.globalDbPath ?? process.env.GLOBAL_DB_PATH ?? resolve(DATA_DIR, 'global.db');
  const globalDb = initGlobalDb(globalDbPath);
  const registry = new AgentRegistry();
  const deviceRegistry = new DeviceRegistry();
  const storageManager = new StorageManager(process.env.STORAGE_BASE_DIR ?? resolve(DATA_DIR, 'storage'));
  const defaultNetworkId = 'default';
  storageManager.createSpace(defaultNetworkId);
  const space = storageManager.getSpace(defaultNetworkId);

  const resolveCustomAgentStatus = (agent: { id: string; source?: string | null; adapterKind?: string | null; command?: string | null; cwd?: string | null; deviceId?: string | null; networkId?: string | null }) => {
    const rt = registry.snapshot(agent.id);
    if (agent.source !== 'custom') {
      return {
        status: rt?.status ?? 'offline',
        lastSeenAt: rt?.lastHeartbeatAt,
        lastError: rt?.lastError?.message,
      };
    }

    if (rt?.status === 'busy' || rt?.status === 'error' || rt?.status === 'connecting') {
      return {
        status: rt.status,
        lastSeenAt: rt.lastHeartbeatAt,
        lastError: rt.lastError?.message,
      };
    }

    if (!projectDirectoryExists(agent.cwd)) {
      return { status: 'offline' as const, lastSeenAt: rt?.lastHeartbeatAt, lastError: undefined };
    }

    const liveDevice = agent.deviceId ? deviceRegistry.get(agent.deviceId) : undefined;
    const persistedDevice = agent.deviceId ? globalDb.devices.get(agent.deviceId) : null;
    const liveCandidates = liveDevice
      ? [liveDevice]
      : agent.deviceId?.startsWith('virtual-')
        ? deviceRegistry.all()
        : [];
    const persistedCandidates = persistedDevice
      ? [persistedDevice]
      : agent.deviceId?.startsWith('virtual-')
        ? globalDb.devices.listByNetwork(agent.networkId ?? defaultNetworkId)
        : [];
    const candidateDevices = [
      ...liveCandidates.map((device) => ({
        lastSeenAt: device.lastSeenAt,
        status: device.status,
        runtimes: device.runtimes ?? [],
      })),
      ...persistedCandidates.map((device) => ({
        lastSeenAt: device.lastSeenAt,
        status: isRecentlySeen(device.lastSeenAt) ? 'online' : 'offline',
        runtimes: device.runtimes ?? [],
      })),
    ];
    for (const device of candidateDevices) {
      if (!device || !isOnlineStatus(device.status)) continue;
      const hasRuntime = (device.runtimes ?? []).some((runtime) => runtimeMatchesAgent(runtime, agent));
      if (hasRuntime) {
        return { status: 'online' as const, lastSeenAt: device.lastSeenAt, lastError: undefined };
      }
    }
    return {
      status: rt?.status ?? 'offline',
      lastSeenAt: rt?.lastHeartbeatAt,
      lastError: rt?.lastError?.message,
    };
  };

  const resolveOwnerName = (ownerId?: string | null) => {
    if (!ownerId) return null;
    return globalDb.users.get(ownerId)?.username ?? null;
  };

  const buildVisibleAgentDtos = (networkId: string) => {
    const registryAgents = registry.all().filter((a) =>
      isTeamAgent(a) &&
      (a.networkId === networkId || a.publishedNetworkIds.includes(networkId))
    ).map((agent) => {
      const dto = snapshotToDto(agent);
      const ownerName = resolveOwnerName(dto.ownerId);
      if (agent.source !== 'custom') return { ...dto, ownerName };
      const resolved = resolveCustomAgentStatus(agent);
      return {
        ...dto,
        ownerName,
        status: resolved.status,
        lastSeenAt: resolved.lastSeenAt ?? dto.lastSeenAt,
        lastError: resolved.lastError,
      };
    });
    const seen = new Set(registryAgents.map((agent) => agent.id));
    const persistedAgents = globalDb.agents.listVisibleInNetwork(networkId)
      .filter(isTeamAgent)
      .filter((agent) => !seen.has(agent.id))
      .map((agent) => {
        let parsedArgs: string[] | null = null;
        if (agent.args) {
          try { parsedArgs = JSON.parse(agent.args); } catch { parsedArgs = [agent.args]; }
        }
        const resolved = resolveCustomAgentStatus(agent);
        return {
          id: agent.id,
          name: agent.name,
          role: agent.role ?? '',
          adapterKind: agent.adapterKind,
          category: agent.category,
          source: agent.source,
          command: agent.command,
          args: parsedArgs,
          cwd: agent.cwd,
          deviceId: agent.deviceId ?? undefined,
          networkId: agent.networkId,
          visibility: agent.visibility,
          ownerId: agent.ownerId,
          ownerName: resolveOwnerName(agent.ownerId),
          description: agent.description,
          status: resolved.status,
          lastSeenAt: resolved.lastSeenAt ?? agent.lastSeenAt,
          lastError: resolved.lastError ?? agent.lastError ?? undefined,
          publishedNetworkIds: globalDb.agentPublishes.listByAgent(agent.id).map((p) => p.networkId),
          connectCommand: renderConnectCommand({ adapterKind: agent.adapterKind as any }),
        };
      });
    return [...registryAgents, ...persistedAgents];
  };

  const visibleDeviceRows = (rows: ReturnType<GlobalDb['devices']['listByUser']>) =>
    rows.filter((device) => !isVirtualDeviceId(device.id));

  const toDeviceDto = (dbd: ReturnType<GlobalDb['devices']['listByUser']>[number]) => {
    const live = deviceRegistry.get(dbd.id);
    return {
      id: dbd.id,
      userId: dbd.userId,
      networkId: dbd.networkId,
      hostname: dbd.hostname,
      agentIds: live ? Array.from(live.agents.keys()) : [],
      runtimes: live?.runtimes ?? dbd.runtimes,
      lastSeenAt: live ? live.lastSeenAt : dbd.lastSeenAt,
      status: live ? live.status : 'offline',
      connectCommand: dbd.connectCommand,
      systemInfo: dbd.systemInfo,
    };
  };

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
  const defaultNetwork = globalDb.networks.get(defaultNetworkId);
  if (!defaultNetwork) {
    globalDb.networks.create({
      id: defaultNetworkId,
      ownerId: 'system',
      name: 'Default Team',
      path: 'default',
      description: null,
      visibility: 'public',
      createdAt: Date.now(),
    });
  } else if (defaultNetwork.name === 'Default Network') {
    globalDb.networks.updateName(defaultNetworkId, 'Default Team');
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
  const channels = new ChannelService({
    storageManager,
    registry,
    getPersistedAgent: (agentId) => {
      const agent = globalDb.agents.getFull(agentId);
      return agent
        ? {
            id: agent.id,
            name: agent.name,
            adapterKind: agent.adapterKind,
            category: agent.category,
            source: agent.source,
          }
        : null;
    },
  });
  channels.ensureDefault(defaultNetworkId);
  const metricsCollector = new AgentMetricsCollector();
  const inviteSessions = new Map<string, import('socket.io').Socket>();

  mkdirSync(artifactDir, { recursive: true });

  const app = express();
  app.disable('x-powered-by');
  const corsOrigin = resolveCorsOrigin();
  attachRestCors(app, corsOrigin);
  app.use(express.json());
  app.get('/healthz', (_req, res) => res.json({ status: 'ok' }));

  const upload = multer({ dest: '/tmp/agentbean-uploads/', limits: { fileSize: 50 * 1024 * 1024 } });
  attachArtifactRoutes({ app, storageManager, upload, token, globalDb });

  app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    logger.error({ err: err?.message, stack: err?.stack }, 'express error');
    res.status(500).json({ error: 'internal error' });
  });

  const server = http.createServer(app);
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

  const artifactDtos = (sp: typeof space, netId: string, artifactIds: string[] = []) =>
    artifactIds
      .map((id) => sp.artifacts.get(id))
      .filter((a): a is NonNullable<typeof a> => Boolean(a))
      .map(a => ({
        id: a.id, filename: a.filename, mimeType: a.mimeType,
        sizeBytes: a.sizeBytes, createdAt: a.createdAt,
        downloadUrl: `/api/networks/${netId}/artifacts/${a.id}/download`,
        previewUrl: `/api/networks/${netId}/artifacts/${a.id}/preview`,
      }));

  const parseMessageMeta = (raw?: string | null): Record<string, any> => {
    if (!raw) return {};
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  };

  const buildDispatchHistory = (messages: ReturnType<typeof space.messages.listByChannel>, parentMessageId?: string) => {
    const selected = parentMessageId
      ? messages.filter((m) => {
          const meta = parseMessageMeta(m.metaJson);
          return m.id === parentMessageId || meta.parentMessageId === parentMessageId || meta.inReplyTo === parentMessageId;
        })
      : messages.slice(-20);
    return selected.slice(-20).map((m) => ({
      role: m.senderKind === 'agent' ? 'assistant' as const : m.senderKind === 'system' ? 'system' as const : 'user' as const,
      speaker: m.senderId ?? m.senderKind,
      body: m.body,
      at: m.createdAt,
    }));
  };

  const socketNetworkMap = new Map<string, string>();

  function emitChannelsSnapshotForNetwork(networkId: string): void {
    for (const s of io.of('/web').sockets.values()) {
      if ((socketNetworkMap.get(s.id) ?? defaultNetworkId) !== networkId) continue;
      const userId = s.data.userId as string | undefined;
      const list = userId ? channels.listForUser(networkId, userId) : channels.list(networkId);
      s.emit('channels:snapshot', list);
    }
  }

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
      socket.emit('agents:snapshot', buildVisibleAgentDtos(networkId));
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
      const userId = socket.data.userId as string | undefined;
      // Load persisted devices from DB
      const dbDevices = visibleDeviceRows(userId ? globalDb.devices.listByUser(userId) : globalDb.devices.listByNetwork(nid));
      // Merge with live registry status
      const devices = dbDevices.map(toDeviceDto);
      socket.emit('devices:snapshot', devices);
    });

    socket.on('members:list', (_payload: {}, ack?: (r: any) => void) => {
      try {
        const networkId = socketNetworkMap.get(socket.id) ?? defaultNetworkId;
        const humans = globalDb.networkMembers.listByNetwork(networkId);
        const agents = buildVisibleAgentDtos(networkId);
        ack?.({ ok: true, humans, agents });
      } catch (e: any) {
        ack?.({ ok: false, error: e.message ?? 'unknown' });
      }
    });

    socket.on('device:agents:list', (payload: { deviceId: string }, ack?: (r: any) => void) => {
      try {
        // Get agents from global DB (persisted scanned agents)
        const globalAgents = globalDb.agents.listByDevice(payload.deviceId);
        // Merge with live AgentRegistry data
        const result = globalAgents
          .filter((ga) => !(ga.source === 'scanned' && ga.category === 'executor-hosted'))
          .map((ga) => {
          const rt = registry.snapshot(ga.id);
          return {
            id: ga.id,
            name: ga.name,
            adapterKind: ga.adapterKind,
            category: ga.category,
            source: ga.source,
            command: ga.command,
            args: ga.args,
            cwd: ga.cwd,
            deviceId: ga.deviceId,
            networkId: ga.networkId,
            visibility: ga.visibility,
            ownerId: ga.ownerId,
            ownerName: resolveOwnerName(ga.ownerId),
            description: ga.description,
            status: rt?.status ?? 'offline',
            publishedNetworkIds: rt?.publishedNetworkIds ?? globalDb.agentPublishes.listByAgent(ga.id).map((p) => p.networkId),
            lastSeenAt: rt?.lastHeartbeatAt ?? ga.lastSeenAt,
            lastError: rt?.lastError ?? ga.lastError ?? undefined,
          };
        });
        const live = deviceRegistry.get(payload.deviceId);
        const dbDevice = globalDb.devices.get(payload.deviceId);
        ack?.({ ok: true, agents: result, runtimes: live?.runtimes ?? dbDevice?.runtimes ?? [] });
      } catch (e: any) {
        ack?.({ ok: false, error: e.message ?? 'unknown' });
      }
    });

    socket.on('agent:custom:list', (payload: { deviceId?: string } = {}, ack?: (r: any) => void) => {
      try {
        const userId = socket.data.userId as string | undefined;
        if (!userId) return ack?.({ ok: false, error: 'UNAUTHENTICATED' });
        const agents = globalDb.agents.listCustomByOwner(userId)
          .filter((agent) => !payload.deviceId || agent.deviceId === payload.deviceId)
          .map((agent) => {
          const rt = registry.snapshot(agent.id);
          const resolved = resolveCustomAgentStatus(agent);
          let parsedArgs: string[] | null = null;
          if (Array.isArray((agent as any).args)) {
            parsedArgs = (agent as any).args;
          } else if (agent.args) {
            try { parsedArgs = JSON.parse(agent.args); } catch { parsedArgs = [agent.args]; }
          }
          return {
            id: agent.id,
            name: agent.name,
            role: agent.role ?? '',
            adapterKind: agent.adapterKind,
            category: agent.category,
            source: agent.source,
            command: agent.command,
            args: parsedArgs,
            cwd: agent.cwd,
            deviceId: agent.deviceId ?? undefined,
            networkId: agent.networkId,
            visibility: agent.visibility,
            ownerId: agent.ownerId,
            ownerName: resolveOwnerName(agent.ownerId),
            description: agent.description,
            status: resolved.status,
            lastSeenAt: resolved.lastSeenAt ?? rt?.lastHeartbeatAt ?? agent.lastSeenAt,
            lastError: resolved.lastError ?? rt?.lastError?.message ?? agent.lastError ?? undefined,
            publishedNetworkIds: rt?.publishedNetworkIds ?? globalDb.agentPublishes.listByAgent(agent.id).map((p) => p.networkId),
            connectCommand: renderConnectCommand({ adapterKind: agent.adapterKind as any }),
          };
        });
        ack?.({ ok: true, agents });
      } catch (e: any) {
        ack?.({ ok: false, error: e.message ?? 'unknown' });
      }
    });

    socket.on('device:get', (payload: { id: string }, ack?: (r: any) => void) => {
      try {
        const dbDevice = globalDb.devices.get(payload.id);
        if (!dbDevice) return ack?.({ ok: false, error: 'NOT_FOUND' });
        const live = deviceRegistry.get(payload.id);
        const agents = live ? Array.from(live.agents.values()) : [];
        ack?.({
          ok: true,
          device: {
            id: dbDevice.id,
            userId: dbDevice.userId,
            networkId: dbDevice.networkId,
            hostname: dbDevice.hostname,
            agentIds: live ? Array.from(live.agents.keys()) : [],
            runtimes: live?.runtimes ?? [],
            lastSeenAt: live ? live.lastSeenAt : dbDevice.lastSeenAt,
            status: live ? live.status : 'offline',
            connectCommand: dbDevice.connectCommand,
            systemInfo: dbDevice.systemInfo,
            agents,
          },
        });
      } catch (e: any) {
        ack?.({ ok: false, error: e.message ?? 'unknown' });
      }
    });

    socket.on('device:delete', (payload: { id: string }, ack?: (r: any) => void) => {
      try {
        globalDb.devices.delete(payload.id);
        ack?.({ ok: true });
        // Refresh device list for this user
        const nid = socketNetworkMap.get(socket.id) ?? defaultNetworkId;
        const userId = socket.data.userId as string | undefined;
        const dbDevices = visibleDeviceRows(userId ? globalDb.devices.listByUser(userId) : globalDb.devices.listByNetwork(nid));
        const devices = dbDevices.map(toDeviceDto);
        socket.emit('devices:snapshot', devices);
      } catch (e: any) {
        ack?.({ ok: false, error: e.message ?? 'unknown' });
      }
    });

    socket.on('device:rename', (payload: { id: string; hostname: string }, ack?: (r: any) => void) => {
      try {
        const hostname = payload.hostname.trim().replace(/\s+/g, '-');
        globalDb.devices.rename(payload.id, hostname);
        ack?.({ ok: true });
        // Refresh device list for all web clients
        const nid = socketNetworkMap.get(socket.id) ?? defaultNetworkId;
        const userId = socket.data.userId as string | undefined;
        const dbDevices = visibleDeviceRows(userId ? globalDb.devices.listByUser(userId) : globalDb.devices.listByNetwork(nid));
        const devices = dbDevices.map(toDeviceDto);
        io.of('/web').emit('devices:snapshot', devices);
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

    // --- Task events ---
    socket.on('task:create', (payload: { title: string; description?: string; status?: string; assigneeId?: string; channelId?: string; tags?: string[] }, ack?: (r: any) => void) => {
      try {
        const userId = socket.data.userId;
        if (!userId) return ack?.({ ok: false, error: 'NOT_AUTHENTICATED' });
        if (!payload.title?.trim()) return ack?.({ ok: false, error: 'EMPTY_TITLE' });
        const networkId = socketNetworkMap.get(socket.id) ?? defaultNetworkId;
        const sp = storageManager.getSpace(networkId);
        const task = sp.tasks.create({
          title: payload.title.trim(),
          description: payload.description,
          status: payload.status as any,
          creatorId: userId,
          assigneeId: payload.assigneeId,
          channelId: payload.channelId,
          tags: payload.tags,
          createdAt: Date.now(),
        });
        ack?.({ ok: true, task });
      } catch (e: any) {
        ack?.({ ok: false, error: e.message ?? 'unknown' });
      }
    });

    socket.on('task:list', (payload: { channelId?: string }, ack?: (r: any) => void) => {
      try {
        const networkId = socketNetworkMap.get(socket.id) ?? defaultNetworkId;
        const sp = storageManager.getSpace(networkId);
        const tasks = sp.tasks.list(payload.channelId);
        ack?.({ ok: true, tasks });
      } catch (e: any) {
        ack?.({ ok: false, error: e.message ?? 'unknown' });
      }
    });

    socket.on('task:update', (payload: { id: string; title?: string; description?: string; status?: string; assigneeId?: string | null; channelId?: string | null; tags?: string[]; sortOrder?: number }, ack?: (r: any) => void) => {
      try {
        const networkId = socketNetworkMap.get(socket.id) ?? defaultNetworkId;
        const sp = storageManager.getSpace(networkId);
        sp.tasks.update(payload.id, {
          title: payload.title,
          description: payload.description,
          status: payload.status as any,
          assigneeId: payload.assigneeId,
          channelId: payload.channelId,
          tags: payload.tags,
          sortOrder: payload.sortOrder,
        });
        const task = sp.tasks.get(payload.id);
        ack?.({ ok: true, task });
      } catch (e: any) {
        ack?.({ ok: false, error: e.message ?? 'unknown' });
      }
    });

    socket.on('task:delete', (payload: { id: string }, ack?: (r: any) => void) => {
      try {
        const networkId = socketNetworkMap.get(socket.id) ?? defaultNetworkId;
        const sp = storageManager.getSpace(networkId);
        sp.tasks.delete(payload.id);
        ack?.({ ok: true });
      } catch (e: any) {
        ack?.({ ok: false, error: e.message ?? 'unknown' });
      }
    });

    socket.on('task:reorder', (payload: { id: string; sortOrder: number }, ack?: (r: any) => void) => {
      try {
        const networkId = socketNetworkMap.get(socket.id) ?? defaultNetworkId;
        const sp = storageManager.getSpace(networkId);
        sp.tasks.updateSort(payload.id, payload.sortOrder);
        ack?.({ ok: true });
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
        if (userId) globalDb.users.setCurrentNetwork(userId, payload.networkId);
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
      if (userId) {
        const dms = channels.listDms(networkId, userId);
        socket.emit('dms:snapshot', dms);
      }
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
        emitChannelsSnapshotForNetwork(networkId);
        const members = channels.membersOf(networkId, ch.id);
        const sp = storageManager.getSpace(networkId);
        const persist = makePersistMessage(sp, networkId);
        await runIntros({
          channel: ch,
          members,
          dispatch: (req) => dispatch({ agentId: req.agentId, channelId: req.channelId, prompt: req.prompt, requestId: req.requestId, networkId }),
          onMessage: persist,
        });
      } catch (e: any) {
        ack?.({ ok: false, error: e.message ?? 'unknown' });
      }
    });

    // DM events
    socket.on('dm:start', (payload: { agentId: string }, ack?: (r: any) => void) => {
      try {
        const networkId = socketNetworkMap.get(socket.id) ?? defaultNetworkId;
        const userId = socket.data.userId as string;
        if (!userId) return ack?.({ ok: false, error: 'NOT_AUTHENTICATED' });
        const dm = channels.findOrCreateDm(networkId, userId, payload.agentId);
        ack?.({ ok: true, dm });
        // Refresh channel and DM lists for this user
        const userChannels = channels.listForUser(networkId, userId);
        socket.emit('channels:snapshot', userChannels);
        const dms = channels.listDms(networkId, userId);
        socket.emit('dms:snapshot', dms);
      } catch (e: any) {
        ack?.({ ok: false, error: e.message ?? 'unknown' });
      }
    });

    socket.on('dm:list', (ack?: (r: any) => void) => {
      const networkId = socketNetworkMap.get(socket.id) ?? defaultNetworkId;
      const userId = socket.data.userId as string;
      if (!userId) return ack?.({ ok: false, error: 'NOT_AUTHENTICATED' });
      const dms = channels.listDms(networkId, userId);
      ack?.({ ok: true, dms });
    });

    socket.on('message:send', async (
      payload: { channelId: string; body: string; clientMsgId?: string; asTask?: boolean; artifactIds?: string[]; parentMessageId?: string },
      ack?: (r: any) => void,
    ) => {
      const networkId = socketNetworkMap.get(socket.id) ?? defaultNetworkId;
      const sp = storageManager.getSpace(networkId);
      const persist = makePersistMessage(sp, networkId);

      const body = (payload?.body ?? '').trim();
      if (!body) return ack?.({ ok: false, error: 'EMPTY' });
      const ch = channels.get(networkId, payload.channelId);
      if (!ch) return ack?.({ ok: false, error: 'NO_CHANNEL' });
      const userId = socket.data.userId as string | undefined;
      if (!userId) return ack?.({ ok: false, error: 'NOT_AUTHENTICATED' });

      const attachmentIds = [...new Set((payload.artifactIds ?? []).filter((id) => typeof id === 'string' && id.trim()))];
      const parentMessageId = typeof payload.parentMessageId === 'string' && payload.parentMessageId.trim()
        ? payload.parentMessageId.trim()
        : undefined;
      let taskId: string | undefined;
      let taskTitle: string | undefined;
      if (payload.asTask) {
        taskTitle = body.split(/\r?\n/)[0]?.trim().slice(0, 80) || '未命名任务';
        const task = sp.tasks.create({
          title: taskTitle,
          description: body,
          status: 'todo',
          creatorId: userId,
          channelId: ch.id,
          tags: ['聊天'],
          createdAt: Date.now(),
        });
        taskId = task.id;
      }
      const humanMsg = {
        id: newId(), channelId: ch.id, senderKind: 'human' as const, senderId: userId,
        body, createdAt: Date.now(),
        metaJson: JSON.stringify({
          clientMsgId: payload.clientMsgId,
          parentMessageId,
          taskId,
          taskTitle,
        }),
      };
      persist({ ...humanMsg, artifactIds: attachmentIds.length ? attachmentIds : undefined });
      if (taskId && taskTitle) {
        persist({
          id: newId(), channelId: ch.id, senderKind: 'system', senderId: null,
          body: `已创建任务：#${taskId.slice(-6)} "${taskTitle}"`,
          createdAt: Date.now(), metaJson: JSON.stringify({ kind: 'task-created', taskId, parentMessageId: humanMsg.id }),
        });
      }
      ack?.({ ok: true, id: humanMsg.id });

      const visibleAgents = buildVisibleAgentDtos(networkId);
      const agentById = new Map(visibleAgents.map((agent) => [agent.id, agent]));
      const dmTargetId = channels.dmTargetId(networkId, ch.id);
      const memberIds = dmTargetId ? [dmTargetId] : channels.memberIds(networkId, ch.id);
      const members = memberIds
        .map((id) => agentById.get(id))
        .filter((agent): agent is NonNullable<typeof agent> => Boolean(agent))
        .map((agent) => ({ id: agent.id, name: agent.name, status: agent.status }));
      const candidates = visibleAgents.map((agent) => ({ id: agent.id, name: agent.name, status: agent.status }));
      const currentHistory = sp.messages.listByChannel(ch.id, 200);
      const threadAgent = parentMessageId && !/^\s*@(\S+)/.test(body)
        ? [...currentHistory].reverse()
            .find((m) => {
              const meta = parseMessageMeta(m.metaJson);
              return m.senderKind === 'agent' && (meta.inReplyTo === parentMessageId || meta.parentMessageId === parentMessageId);
            })
        : null;
      const threadTarget = threadAgent?.senderId ? agentById.get(threadAgent.senderId) : undefined;

      const route = threadTarget && (threadTarget.status === 'online' || threadTarget.status === 'busy')
        ? { targets: [{ id: threadTarget.id, name: threadTarget.name, status: threadTarget.status }], reason: 'FALLBACK' as const }
        : routeHumanMessage({ body, members, candidates });

      if (route.reason === 'NO_ONLINE') {
        persist({
          id: newId(), channelId: ch.id, senderKind: 'system', senderId: null,
          body: '当前没有在线 Agent 可响应,消息已保存。',
          createdAt: Date.now(), metaJson: JSON.stringify({ kind: 'no-online-agent' }),
        });
        return;
      }
      if (route.reason === 'UNKNOWN_MENTION' || route.targets.length === 0) {
        persist({
          id: newId(), channelId: ch.id, senderKind: 'system', senderId: null,
          body: '未找到被 @ 的在线 Agent，消息已保存。',
          createdAt: Date.now(), metaJson: JSON.stringify({ kind: 'unknown-mention' }),
        });
        return;
      }

      const recipient = route.targets[0]!;
      const reqId = newId();
      const attachments = artifactDtos(sp, networkId, attachmentIds);
      const historyMessages = currentHistory.filter((m) => m.id !== humanMsg.id);
      const reply = await dispatch({
        agentId: recipient.id,
        channelId: ch.id,
        prompt: body,
        requestId: reqId,
        networkId,
        history: buildDispatchHistory(historyMessages, parentMessageId),
        attachments,
      });
      if (reply.ok && reply.body?.trim()) {
        const artifactIds = reply.artifactIds;
        persist({
          id: newId(), channelId: ch.id, senderKind: 'agent', senderId: recipient.id,
          body: reply.body.trim(), createdAt: Date.now(),
          metaJson: JSON.stringify({ inReplyTo: parentMessageId ?? humanMsg.id, requestId: reqId }),
          artifactIds: artifactIds?.length ? artifactIds : undefined,
        });
      } else {
        const error = reply.error ?? (reply.ok ? 'Agent 返回了空响应' : 'unknown');
        persist({
          id: newId(), channelId: ch.id, senderKind: 'system', senderId: null,
          body: `${recipient.name} 处理失败: ${error}`,
          createdAt: Date.now(), metaJson: JSON.stringify({ kind: 'reply-fail', agentId: recipient.id }),
        });
      }
    });

    socket.on('message:search', (payload: { query: string; limit?: number }, ack?: (r: any) => void) => {
      try {
        const networkId = socketNetworkMap.get(socket.id) ?? defaultNetworkId;
        const sp = storageManager.getSpace(networkId);
        const query = (payload?.query ?? '').trim();
        const results = sp.messages.search(query, payload?.limit ?? 20);
        ack?.({ ok: true, messages: results });
      } catch (e: any) {
        ack?.({ ok: false, error: e.message ?? 'unknown' });
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

    socket.on('channel:update', (payload: { channelId: string; name?: string; visibility?: 'public' | 'private' }, ack?: (r: any) => void) => {
      try {
        const networkId = socketNetworkMap.get(socket.id) ?? defaultNetworkId;
        const ch = channels.get(networkId, payload.channelId);
        if (!ch) return ack?.({ ok: false, error: 'NOT_FOUND' });
        channels.update(networkId, payload.channelId, { name: payload.name, visibility: payload.visibility });
        ack?.({ ok: true });
        emitChannelsSnapshotForNetwork(networkId);
      } catch (e: any) {
        ack?.({ ok: false, error: e.message ?? 'unknown' });
      }
    });

    socket.on('agent:create', (payload: { name: string; role?: string; adapterKind: string; visibility?: 'public' | 'private'; networkId?: string; category?: string; ownerId?: string; command?: string; args?: string[]; cwd?: string; description?: string; deviceId?: string; publishedNetworkIds?: string[] }, ack?: (r: any) => void) => {
      try {
        const name = payload.name.trim().replace(/\s+/g, '-');
        if (!name) return ack?.({ ok: false, error: 'EMPTY_NAME' });
        const targetNetworkId = payload.networkId ?? socket.data.networkId ?? socketNetworkMap.get(socket.id) ?? defaultNetworkId;
        const userId = socket.data.userId as string | undefined;
        const network = globalDb.networks.get(targetNetworkId);
        if (userId && network?.visibility !== 'public' && !globalDb.networkMembers.isMember(targetNetworkId, userId)) {
          return ack?.({ ok: false, error: 'FORBIDDEN' });
        }
        const id = newId();
        const now = Date.now();
        const category = (payload.category as import('./db.js').AgentCategory) ?? 'executor-hosted';
        const requestedDevice = payload.deviceId ? globalDb.devices.get(payload.deviceId) as any : null;
        const useRequestedDevice = Boolean(requestedDevice && (!userId || requestedDevice.userId === userId));
        const deviceId = useRequestedDevice
          ? payload.deviceId!
          : `virtual-${userId ?? 'system'}`;
        if (!useRequestedDevice) {
          globalDb.devices?.upsert({
            id: deviceId,
            userId: userId ?? 'system',
            networkId: targetNetworkId,
            lastSeenAt: now,
          });
        }

        const row = {
          id, name, role: payload.role ?? null,
          adapterKind: payload.adapterKind as import('./db.js').AdapterKind,
          deviceId,
          networkId: targetNetworkId,
          visibility: payload.visibility ?? 'public',
          category,
          source: 'custom' as const,
          firstSeenAt: now, lastSeenAt: now, lastError: null,
          ownerId: payload.ownerId ?? userId ?? null,
          command: payload.command ?? null,
          args: payload.args ? JSON.stringify(payload.args) : null,
          cwd: payload.cwd ?? null,
          description: payload.description ?? null,
        };
        db.agents.create(row);

        globalDb.agents.upsert({
          id, name, role: payload.role ?? null,
          adapterKind: payload.adapterKind as import('./db.js').AdapterKind,
          deviceId,
          networkId: targetNetworkId,
          visibility: payload.visibility ?? 'public',
          category,
          source: 'custom',
          firstSeenAt: now, lastSeenAt: now,
          lastError: undefined,
          ownerId: payload.ownerId ?? userId ?? undefined,
          command: payload.command ?? undefined,
          args: payload.args ? JSON.stringify(payload.args) : undefined,
          cwd: payload.cwd ?? undefined,
          description: payload.description ?? undefined,
        } as any);

        // Register in registry as virtual (offline, no socket)
        const rt = registry.registerVirtual({
          id, name,
          role: payload.role ?? '',
          adapterKind: payload.adapterKind as import('./db.js').AdapterKind,
          category,
          networkId: targetNetworkId,
          visibility: payload.visibility ?? 'public',
          ownerId: payload.ownerId ?? userId ?? null,
          command: payload.command ?? null,
          args: payload.args ?? null,
          cwd: payload.cwd ?? null,
          description: payload.description ?? null,
          publishedNetworkIds: [],
          source: 'custom',
        });

        // Auto-publish to specified networks
        if (payload.publishedNetworkIds?.length && userId) {
          for (const netId of payload.publishedNetworkIds) {
            if (globalDb.networkMembers.isMember(netId, userId)) {
              globalDb.agentPublishes.publish(id, netId, userId);
            }
          }
          const publishes = globalDb.agentPublishes.listByAgent(id);
          rt.publishedNetworkIds = publishes.map((p: any) => p.networkId);
        }

        ack?.({ ok: true, agent: row });
        for (const s of io.of('/web').sockets.values()) {
          const sidNetworkId = socketNetworkMap.get(s.id) ?? defaultNetworkId;
          s.emit('agents:snapshot', buildVisibleAgentDtos(sidNetworkId));
        }
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

    socket.on('agent:config:update', (payload: { id: string; name: string; adapterKind?: string; command?: string; cwd?: string | null; description?: string | null }, ack?: (r: any) => void) => {
      try {
        const userId = socket.data.userId as string | undefined;
        if (!userId) return ack?.({ ok: false, error: 'UNAUTHORIZED' });
        const existing = globalDb.agents.getFull(payload.id);
        if (!existing) return ack?.({ ok: false, error: 'NOT_FOUND' });
        const isCustom = existing.source === 'custom';
        const isAgentOS = existing.category === 'agentos-hosted';
        if (!isCustom && !isAgentOS) return ack?.({ ok: false, error: 'NOT_CONFIGURABLE_AGENT' });
        if (existing.ownerId && existing.ownerId !== userId) return ack?.({ ok: false, error: 'FORBIDDEN' });
        const name = payload.name.trim();
        if (!name) return ack?.({ ok: false, error: 'EMPTY_NAME' });
        if (/\s/.test(name)) return ack?.({ ok: false, error: 'NAME_HAS_SPACE' });
        const adapterKind = isCustom ? payload.adapterKind?.trim() : undefined;
        const command = isCustom ? payload.command?.trim() : undefined;
        if (isCustom && !adapterKind) return ack?.({ ok: false, error: 'EMPTY_RUNTIME' });
        if (isCustom && !command) return ack?.({ ok: false, error: 'EMPTY_COMMAND' });
        const cwd = payload.cwd?.trim() || null;
        const description = payload.description?.trim() || null;
        const updatedAt = Date.now();
        globalDb.agents.updateConfig(payload.id, {
          name,
          adapterKind: adapterKind ?? null,
          command: command ?? null,
          cwd,
          description,
          updatedAt,
        });
        const rt = registry.updateConfig(payload.id, {
          name,
          adapterKind: adapterKind as import('./db.js').AdapterKind | undefined,
          command,
          cwd,
          description,
        });
        if (rt) io.of('/web').emit('agent:status', snapshotToDto(rt));
        ack?.({ ok: true, agent: globalDb.agents.getFull(payload.id) });
      } catch (e: any) {
        ack?.({ ok: false, error: e.message ?? 'unknown' });
      }
    });

    socket.on('agent:publish', (payload: { agentId: string; networkId: string }, ack?: (r: any) => void) => {
      try {
        const userId = socket.data.userId as string | undefined;
        if (!userId) return ack?.({ ok: false, error: 'UNAUTHORIZED' });
        const rt = registry.snapshot(payload.agentId);
        const persisted = rt ? null : globalDb.agents.getFull(payload.agentId);
        if (!rt && !persisted) return ack?.({ ok: false, error: 'NOT_FOUND' });
        const ownerId = rt?.ownerId ?? persisted?.ownerId;
        if (ownerId && ownerId !== userId) return ack?.({ ok: false, error: 'FORBIDDEN' });
        const category = rt?.category ?? persisted?.category;
        const source = rt?.source ?? persisted?.source;
        if (!isTeamAgent({ category, source })) {
          return ack?.({ ok: false, error: 'RUNTIME_NOT_AGENT' });
        }

        // Runtime (executor-hosted) can only be published to private or owned networks
        const targetNetwork = globalDb.networks.get(payload.networkId);
        if (category === 'executor-hosted' && targetNetwork) {
          const isPrivate = targetNetwork.type === 'private';
          const isOwner = targetNetwork.ownerId === userId;
          if (!isPrivate && !isOwner) {
            return ack?.({ ok: false, error: 'RUNTIME_PUBLISH_FORBIDDEN' });
          }
        }

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
        const persisted = rt ? null : globalDb.agents.getFull(payload.agentId);
        if (!rt && !persisted) return ack?.({ ok: false, error: 'NOT_FOUND' });
        const ownerId = rt?.ownerId ?? persisted?.ownerId;
        if (ownerId && ownerId !== userId) return ack?.({ ok: false, error: 'FORBIDDEN' });
        const category = rt?.category ?? persisted?.category;
        const source = rt?.source ?? persisted?.source;
        if (!isTeamAgent({ category, source })) {
          return ack?.({ ok: false, error: 'RUNTIME_NOT_AGENT' });
        }
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
          // Only store the first socket (the daemon's) — don't let browser validation overwrite it
          if (!inviteSessions.has(`device:${payload.code}`)) {
            inviteSessions.set(`device:${payload.code}`, socket);
          }
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
        const username = payload.username.trim().replace(/\s+/g, '-');
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
        globalDb.users.setCurrentNetwork(userId, privateNetwork.id);
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
        const memberNetworkIds = members.map(m => m.networkId);

        // Prefer: joined network > saved current > first member > default
        let primaryNetwork = joinedNetworkId;
        if (!primaryNetwork && user.currentNetworkId && memberNetworkIds.includes(user.currentNetworkId)) {
          primaryNetwork = user.currentNetworkId;
        }
        if (!primaryNetwork) {
          primaryNetwork = members[0]?.networkId ?? defaultNetworkId;
        }

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
        globalDb.users.setCurrentNetwork(user.id, networkId);
        socket.data.userId = user.id;
        socket.data.networkId = networkId;
        socket.data.role = user.role;
        socketNetworkMap.set(socket.id, networkId);
        const devNetRow = globalDb.networks.get(networkId);
        ack?.({ ok: true, token: userToken, networkId, networkPath: devNetRow?.path ?? 'default', userId: user.id, username: user.username, role: user.role });

        // Deliver token to the daemon socket waiting on this invite code
        const daemonSocket = inviteSessions.get(`device:${payload.inviteCode}`);
        if (daemonSocket) {
          daemonSocket.emit('auth:token:deliver', { token: userToken, userId: user.id, networkId });
          inviteSessions.delete(`device:${payload.inviteCode}`);
        }
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
          networkName: network?.name ?? '未知团队',
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
